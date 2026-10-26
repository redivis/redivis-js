import Dataset from './Dataset.js';
import TabularReader from './TabularReader.js';
import Upload from './Upload.js';
import Variable from './Variable.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest, makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { mapConcurrent } from '../common/pool.js';
import { createTempUploads, resolveFiles, uploadToTempUpload } from '../common/upload.js';
import { definedValues, splitReference } from '../common/references.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

/**
 * @typedef {object} TableOptions
 * @property {Dataset} [dataset]
 * @property {Workflow} [workflow]
 * @property {Record<string, any>} [properties]
 */

/**
 * Metadata to update for a variable, by name.
 * @typedef {{name: string, label?: string, description?: string, valueLabels?: {value: string, label: string}[]}} VariableMetadata
 */

/**
 * @typedef {string | Blob | ArrayBuffer | ArrayBufferView | {name: string, data: Blob | ArrayBuffer | ArrayBufferView | string} | {path: string, name?: string}} FileSpecification
 *   A file path (in Node), a File (named by its path within a picked directory, if any), or `{ name, data }` (string
 *   data is uploaded as UTF-8 text)
 */

/**
 * @typedef {object} AddFilesOptions
 * @property {FileSpecification[] | FileList} [files] The files to add
 * @property {string} [directory] A local directory (in Node), whose files are all added, named by their path within
 *   it. Hidden files are skipped.
 * @property {number} [maxParallelization] The number of files to upload at once
 * @property {(progress: {bytesUploaded: number, totalBytes: number, filesUploaded: number, totalFiles: number}) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

export default class Table extends TabularReader {
	/**
	 * A table in a dataset or workflow.
	 *
	 * @param {[name: string, options?: TableOptions] | [options: TableOptions & {name: string}]} args The table's name.
	 *   If no dataset or workflow is given, this may be fully qualified (`owner.dataset_or_workflow.table`), or else the
	 *   table is resolved within the configured `defaultWorkflow` or `defaultDataset`.
	 */
	constructor(...args) {
		super();
		let { name, dataset, workflow, properties } = parseArgs(args, ['name'], {
			allowed: ['dataset', 'workflow', 'properties'],
		});

		let referenceScope;
		let isWorkflowTable = false;
		const parts = splitReference(name);

		if (dataset) {
			referenceScope = dataset.qualifiedReference;
		} else if (workflow) {
			referenceScope = workflow.qualifiedReference;
			isWorkflowTable = true;
		} else if (parts.length === 3) {
			// Whether the container is a dataset or a workflow is resolved once we know more about the table
			referenceScope = `${parts[0]}.${parts[1]}`;
			name = parts[2];
			dataset = new Dataset(referenceScope);
			workflow = new Workflow(referenceScope);
		} else if (getConfigValue('defaultWorkflow')) {
			workflow = new Workflow(getConfigValue('defaultWorkflow'));
			referenceScope = workflow.qualifiedReference;
			isWorkflowTable = true;
		} else if (getConfigValue('defaultDataset')) {
			dataset = new Dataset(getConfigValue('defaultDataset'));
			referenceScope = dataset.qualifiedReference;
		} else {
			throw new ValueError(
				`Invalid table reference "${name}". It must be fully qualified (owner.dataset.table) if no dataset or workflow is specified.`,
			);
		}

		/** @type {string} */
		this.name = name;
		/** @type {Dataset | undefined} */
		this.dataset = dataset;
		/** @type {Workflow | undefined} */
		this.workflow = workflow;
		/** @type {string} */
		this.qualifiedReference = properties?.qualifiedReference ?? `${referenceScope}.${name}`;
		/** @type {string} */
		this.scopedReference = properties?.scopedReference ?? name;
		if (properties?.uri) {
			this.uri = properties.uri;
		} else if (isWorkflowTable) {
			// Tables are resolved within their workflow, which also finds tables inherited through its datasources
			this.uri = `${workflow.uri}/tables/${encodeURIComponent(this.scopedReference)}`;
		} else {
			this.uri = `/tables/${encodeURIComponent(this.qualifiedReference)}`;
		}
		this.properties = properties;
	}

	/**
	 * Creates the table, in the next version of its dataset.
	 *
	 * @param {[options?: {description?: string, uploadMergeStrategy?: 'append' | 'replace', isFileIndex?: boolean}]} args
	 *   `uploadMergeStrategy` is how uploads to the table are combined (default `append`); `isFileIndex` makes the table an
	 *   index of files.
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const { description, uploadMergeStrategy, isFileIndex } = parseArgs(args, [], {
			defaults: { uploadMergeStrategy: 'append', isFileIndex: false },
			allowed: ['description'],
		});
		await this._rectifyAmbiguousContainer();
		if (!this.dataset) {
			throw new ValueError('Only tables in a dataset can be created');
		}
		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${this.dataset.uri}/tables`,
				payload: definedValues({ name: this.name, uploadMergeStrategy, isFileIndex, description }),
			}),
		);
		return this;
	}

	/**
	 * Updates the table's metadata. Only the options that are passed are changed.
	 *
	 * @param {[options: {name?: string, description?: string, uploadMergeStrategy?: 'append' | 'replace'}]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['name', 'description', 'uploadMergeStrategy'] });
		await this._resolveForWrite();
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * Deletes the table.
	 * @returns {Promise<void>}
	 */
	async delete() {
		await this._resolveForWrite();
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Updates the metadata of many of the table's variables at once.
	 *
	 * @param {[variables: VariableMetadata[]] | [options: {variables: VariableMetadata[]}]} args
	 * @returns {Promise<void>}
	 */
	async updateVariables(...args) {
		const { variables } = parseArgs(args, ['variables']);
		await this._resolveForWrite();
		await makeRequest({ method: 'PATCH', path: `${this.uri}/variables`, payload: { variables } });
	}

	/**
	 * Returns an upload to the table, which is created with `upload.create()`.
	 *
	 * @param {[name?: string] | [options?: {name?: string}]} args The upload's name. Defaults to the name of the uploaded
	 *   file, if any.
	 * @returns {Upload}
	 */
	upload(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Upload(name, { table: this });
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Upload[]>}
	 */
	async listUploads(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const uploads = await makePaginatedRequest({ path: `${this.uri}/uploads`, pageSize: 100, maxResults });
		return uploads.map((upload) => new Upload(upload.name, { table: this, properties: upload }));
	}

	/**
	 * Adds files to a file index table, uploading them in parallel batches.
	 *
	 * @param {[options: AddFilesOptions]} args
	 * @returns {Promise<void>}
	 */
	async addFiles(...args) {
		const { files, directory, maxParallelization, onProgress, signal } = parseArgs(args, [], {
			defaults: { maxParallelization: Math.min(100, (globalThis.navigator?.hardwareConcurrency || 4) * 5) },
			allowed: ['files', 'directory', 'onProgress', 'signal'],
		});
		const resolvedFiles = await resolveFiles({ files, directory });
		await this._resolveForWrite();

		const totalBytes = resolvedFiles.reduce((total, { size }) => total + size, 0);
		const bytesUploadedByFile = new Array(resolvedFiles.length).fill(0);
		let bytesUploaded = 0;
		let filesUploaded = 0;
		const reportProgress = () =>
			onProgress?.({ bytesUploaded, totalBytes, filesUploaded, totalFiles: resolvedFiles.length });

		// Files are uploaded in batches (of at most 1000 files, and roughly a target size that adapts to throughput),
		//   each of which is added to the table once it's uploaded
		let targetBatchBytes = 1e8;
		let index = 0;
		while (index < resolvedFiles.length) {
			const batchStart = index;
			let batchBytes = 0;
			while (index < resolvedFiles.length && index - batchStart < 1000 && batchBytes <= targetBatchBytes) {
				batchBytes += resolvedFiles[index++].size;
			}
			const batch = resolvedFiles.slice(batchStart, index);
			const startedAt = Date.now();

			const tempUploads = await createTempUploads(this.uri, batch, { signal });
			await mapConcurrent(
				batch,
				maxParallelization,
				async (file, i) => {
					const fileIndex = batchStart + i;
					await uploadToTempUpload(tempUploads[i], file, {
						signal,
						onProgress: (bytes) => {
							bytesUploaded += bytes - bytesUploadedByFile[fileIndex];
							bytesUploadedByFile[fileIndex] = bytes;
							reportProgress();
						},
					});
				},
				{ signal },
			);

			await makeRequest({
				method: 'POST',
				path: `${this.uri}/rawFiles`,
				signal,
				payload: { files: batch.map(({ name }, i) => ({ name, tempUploadId: tempUploads[i].id })) },
			});
			filesUploaded += batch.length;
			reportProgress();

			const elapsed = Date.now() - startedAt;
			if (elapsed > 60_000) {
				targetBatchBytes /= 2;
			} else if (elapsed < 15_000) {
				targetBatchBytes *= 2;
			}
		}
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Variable}
	 */
	variable(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Variable(name, { table: this });
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Variable[]>}
	 */
	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { table: this, properties: variable }));
	}

	/** @protected @returns {Promise<{table: Table}>} */
	async _getFileSource() {
		return { table: this };
	}

	/** @protected */
	async _getReadInfo() {
		// Always refetched, since the table may have changed
		await this.get();
		return { numRows: this.properties.numRows, numBytes: this.properties.numBytes, canListRows: true };
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name;
		if (this.dataset && this.workflow && properties.container?.kind) {
			if (properties.container.kind === 'dataset') {
				this.workflow = undefined;
			} else {
				this.dataset = undefined;
			}
		}
	}

	// A table addressed within its workflow (/workflows/:workflow/tables/:table) may be inherited from one of the
	//   workflow's datasources. Writes must never go through that URI, since that would make it easy to unintentionally
	//   modify a table outside of the workflow, so the table is fetched to get its canonical URI first.
	/** @protected */
	async _resolveForWrite() {
		if (isWorkflowScopedUri(this.uri)) {
			await this.get();
		}
	}

	// When the container came from a qualified reference, we don't know whether it's a dataset or a workflow until the
	//   API tells us (or we ask)
	/** @protected */
	async _rectifyAmbiguousContainer() {
		if (this.dataset && this.workflow) {
			if (await this.dataset.exists()) {
				this.workflow = undefined;
			} else {
				this.dataset = undefined;
			}
		}
	}
}

function isWorkflowScopedUri(uri) {
	return /^\/workflows\/[^/]+\/tables\//.test(uri);
}

// The qualified reference to send for a table in a write (e.g., a transform's source table)
export async function tableReferenceForWrite(table) {
	if (table instanceof Table) {
		await table._resolveForWrite();
		return table.qualifiedReference;
	}
	return table;
}
