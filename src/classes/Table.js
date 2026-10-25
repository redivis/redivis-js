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

export default class Table extends TabularReader {
	/**
	 * @param {string} name The table's name. If no dataset or workflow is given, this may be fully qualified
	 *   (`owner.dataset_or_workflow.table`), or else the table is resolved within the configured defaultWorkflow or
	 *   defaultDataset.
	 * @param {object} [options]
	 * @param {Dataset} [options.dataset]
	 * @param {Workflow} [options.workflow]
	 * @param {object} [options.properties]
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

		this.name = name;
		this.dataset = dataset;
		this.workflow = workflow;
		this.qualifiedReference = properties?.qualifiedReference ?? `${referenceScope}.${name}`;
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
	 * @param {object} [options]
	 * @param {string} [options.description]
	 * @param {'append'|'replace'} [options.uploadMergeStrategy='append'] How uploads to the table are combined
	 * @param {boolean} [options.isFileIndex=false] Whether the table is an index of files
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
	 * @param {object} options
	 * @param {string} [options.name]
	 * @param {string} [options.description]
	 * @param {'append'|'replace'} [options.uploadMergeStrategy]
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['name', 'description', 'uploadMergeStrategy'] });
		await this._resolveForWrite();
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	async delete() {
		await this._resolveForWrite();
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Updates the metadata of many of the table's variables at once.
	 * @param {object[]} variables
	 * @returns {Promise<void>}
	 */
	async updateVariables(...args) {
		const { variables } = parseArgs(args, ['variables']);
		await this._resolveForWrite();
		await makeRequest({ method: 'PATCH', path: `${this.uri}/variables`, payload: { variables } });
	}

	/**
	 * @param {string} [name] The upload's name. Defaults to the name of the uploaded file, if any.
	 * @returns {Upload}
	 */
	upload(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Upload(name, { table: this });
	}

	async listUploads(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const uploads = await makePaginatedRequest({ path: `${this.uri}/uploads`, pageSize: 100, maxResults });
		return uploads.map((upload) => new Upload(upload.name, { table: this, properties: upload }));
	}

	/**
	 * Adds files to a file index table.
	 *
	 * @param {object} options One of files or directory is required
	 * @param {Array<string|File|Blob|{name: string, data: Blob|ArrayBuffer|ArrayBufferView|string}|{path: string, name?: string}>|FileList} [options.files]
	 *   The files to add: paths (in Node), Files (named by their path within a picked directory, if any), or
	 *   `{ name, data }` objects. String data is uploaded as UTF-8 text.
	 * @param {string} [options.directory] A local directory (in Node), whose files are all added, named by their path
	 *   within it. Hidden files are skipped.
	 * @param {number} [options.maxParallelization] The number of files to upload at once
	 * @param {(progress: {bytesUploaded: number, totalBytes: number, filesUploaded: number, totalFiles: number}) => void} [options.onProgress]
	 * @param {AbortSignal} [options.signal]
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

	variable(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Variable(name, { table: this });
	}

	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { table: this, properties: variable }));
	}

	async _getReadInfo() {
		// Always refetched, since the table may have changed
		await this.get();
		return { numRows: this.properties.numRows, numBytes: this.properties.numBytes, canListRows: true };
	}

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
	async _resolveForWrite() {
		if (isWorkflowScopedUri(this.uri)) {
			await this.get();
		}
	}

	// When the container came from a qualified reference, we don't know whether it's a dataset or a workflow until the
	//   API tells us (or we ask)
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
