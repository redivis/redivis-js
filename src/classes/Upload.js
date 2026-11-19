import TabularReader from './TabularReader.js';
import Variable from './Variable.js';
import { makePaginatedRequest, makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { JobError, ValueError } from '../common/errors.js';
import { computeMd5Base64, createImport, finalizeImport, uploadImportFile, waitForImport } from '../common/imports.js';
import { definedValues } from '../common/references.js';
import { resolveContent } from '../common/upload.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */
/** @typedef {import('./Table.js').default} Table */

/**
 * @typedef {Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string | Record<string, any>[] | import('apache-arrow').Table} UploadContent
 */

/**
 * @typedef {object} UploadOptions
 * @property {string} [type] The file type (e.g. `delimited`, `parquet`, `jsonl`, `stream`). Inferred from the name
 *   if not given.
 * @property {number} [size] The size in bytes, required when the content is a ReadableStream
 * @property {Record<string, any>} [transferSpecification] Import the data from
 *   another source, rather than uploading content: its `sourceType` (`url`, `gcs`, `s3`, `gDrive`, `box`, `bigQuery`,
 *   or `redivis`), its `sourcePath`, and, for a source that's accessed through one of your integrations, its
 *   `identity` (the email of that integration's account)
 * @property {Record<string, any>[]} [schema] The variables of a `stream` upload
 * @property {Record<string, any>} [metadata] Variable metadata, keyed by variable name
 * @property {string} [delimiter]
 * @property {boolean} [hasHeaderRow=true]
 * @property {boolean} [skipBadRecords=false]
 * @property {boolean} [hasQuotedNewlines]
 * @property {string} [quoteCharacter]
 * @property {string} [escapeCharacter]
 * @property {string[]} [nullMarkers]
 * @property {boolean} [allowJaggedRows=false]
 * @property {boolean} [ifNotExists=false] Do nothing if an upload with this name already exists
 * @property {boolean} [replaceOnConflict=false] Replace an existing upload with this name
 * @property {boolean} [renameOnConflict=false] Give the upload a new name if one with this name exists
 * @property {boolean} [waitForFinish=true] Wait for the data to be imported
 * @property {boolean} [raiseOnFail=true] Throw a JobError if the import fails
 * @property {boolean} [removeOnFail=false] Delete the upload if the import fails
 * @property {(progress: {bytesUploaded: number, totalBytes: number}) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

export default class Upload extends TabularReader {
	/** The import that created this upload, which is polled while it's processed */
	#import;

	/**
	 * An upload of data to a table, in the next version of its dataset.
	 *
	 * @param {[name?: string, options?: {table: Table, properties?: Record<string, any>}] | [options: {name?: string, table: Table, properties?: Record<string, any>}]} args
	 *   The upload's name. Defaults to the name of the uploaded file, if any.
	 */
	constructor(...args) {
		super();
		const { name = '', table, properties } = parseArgs(args, ['name'], { allowed: ['table', 'properties'] });
		/** @type {string} */
		this.name = name;
		/** @type {Table} */
		this.table = table;
		this.properties = properties;
		this.uri = properties?.uri ?? uploadUri(table, name);
	}

	toString() {
		return `<Upload ${this.table.qualifiedReference}.${this.name}>`;
	}

	/**
	 * Uploads data to the table, and (by default) waits for it to be imported.
	 *
	 * @example
	 * await table.upload('data.csv').create(file);
	 * await table.upload('rows').create([{ id: 1, name: 'a' }]);
	 *
	 * @param {[content?: UploadContent, options?: UploadOptions] | [options?: UploadOptions & {content?: UploadContent}]} args
	 *   The data to upload: a Blob or File; an ArrayBuffer or typed array; a ReadableStream (with the `size` option); a
	 *   file path (in Node); or tabular data (an array of row objects, or an arrow Table), which is uploaded as
	 *   newline-delimited JSON. Omit it for a `transferSpecification` or a `type: 'stream'` upload.
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const options = parseArgs(args, ['content'], {
			defaults: {
				hasHeaderRow: true,
				skipBadRecords: false,
				allowJaggedRows: false,
				ifNotExists: false,
				replaceOnConflict: false,
				renameOnConflict: false,
				waitForFinish: true,
				raiseOnFail: true,
				removeOnFail: false,
			},
			allowed: [
				'type',
				'size',
				'transferSpecification',
				'schema',
				'metadata',
				'delimiter',
				'hasQuotedNewlines',
				'quoteCharacter',
				'escapeCharacter',
				'nullMarkers',
				'onProgress',
				'signal',
			],
		});
		const { content, onProgress, signal } = options;
		let { type } = options;

		if (options.replaceOnConflict && options.renameOnConflict) {
			throw new ValueError('replaceOnConflict and renameOnConflict cannot both be true');
		}
		if (options.schema && type !== 'stream') {
			console.warn("The schema option is ignored for uploads that aren't of type `stream`");
		}

		// Uploads are written through the table's own URI, never one scoped to a workflow
		const tableUri = this.table.uri;
		await this.table._resolveForWrite();
		if (this.table.uri !== tableUri) {
			this.uri = uploadUri(this.table, this.name);
		}

		const resolvedContent =
			content === undefined || content === null ? undefined : await resolveContent(content, options);
		if (resolvedContent) {
			type ??= resolvedContent.type;
			if (!this.name && resolvedContent.name) {
				this.name = resolvedContent.name;
				this.uri = uploadUri(this.table, this.name);
			}
		}

		// Check for a conflict before uploading anything
		if (this.name && (await this.exists())) {
			if (options.ifNotExists) {
				return this.get();
			} else if (options.replaceOnConflict) {
				await this.delete();
			} else if (!options.renameOnConflict) {
				throw new ValueError(
					`An upload named "${this.name}" already exists on this version of the table. To upload it anyway, set renameOnConflict or replaceOnConflict to true.`,
				);
			}
		}

		const tabularOptions = {
			metadata: options.metadata,
			hasHeaderRow: options.hasHeaderRow,
			skipBadRecords: options.skipBadRecords,
			hasQuotedNewlines: options.hasQuotedNewlines,
			allowJaggedRows: options.allowJaggedRows,
			quoteCharacter: options.quoteCharacter,
			escapeCharacter: options.escapeCharacter,
			nullMarkers: options.nullMarkers,
			delimiter: options.delimiter,
		};

		if (resolvedContent) {
			const { size } = resolvedContent;
			const md5Hash = await computeMd5Base64(resolvedContent, { signal });
			let dataImport = await createImport(
				this.table.uri,
				{
					name: this.name || undefined,
					type,
					...tabularOptions,
					totalFileCount: 1,
					totalSize: size,
				},
				{ signal },
			);
			this.#setImport(dataImport);
			onProgress?.({ bytesUploaded: 0, totalBytes: size });
			await uploadImportFile(
				dataImport,
				resolvedContent.name || dataImport.name || (type ? `data.${type}` : 'data'),
				resolvedContent,
				{ md5Hash, onProgress: (bytesUploaded) => onProgress?.({ bytesUploaded, totalBytes: size }), signal },
			);
			dataImport = await finalizeImport(dataImport, { signal });
			await this.#finishImport(dataImport, options);
		} else if (options.transferSpecification) {
			const { sourceType, sourcePath, identity } = options.transferSpecification;
			const dataImport = await createImport(
				this.table.uri,
				{
					name: this.name || undefined,
					type,
					sourceType,
					sourcePaths: sourcePath === undefined || sourcePath === null ? undefined : [sourcePath],
					identity,
					...tabularOptions,
				},
				{ signal },
			);
			this.#setImport(dataImport);
			await this.#finishImport(dataImport, options);
		} else {
			// A stream upload, into which rows are inserted
			this._updateProperties(
				await makeRequest({
					method: 'POST',
					path: `${this.table.uri}/uploads`,
					signal,
					payload: definedValues({ name: this.name, type, schema: options.schema, ...tabularOptions }),
				}),
			);
		}
		return this;
	}

	// Takes the name the import was given (which differs from the one asked for if it was renamed on a conflict), and
	//   addresses the upload by it, as an upload is by its name
	#setImport(dataImport) {
		this.#import = dataImport;
		this.name = dataImport.name ?? this.name;
		this.uri = uploadUri(this.table, this.name);
	}

	// Waits for the import to be processed (if asked to), then fetches the upload it created
	async #finishImport(dataImport, { waitForFinish, raiseOnFail, removeOnFail, signal }) {
		if (waitForFinish) {
			dataImport = await waitForImport(dataImport, { raiseOnFail: false, signal });
			this.#import = dataImport;
		}
		await this.get();
		if (waitForFinish && dataImport.status !== 'completed') {
			const error = new JobError({ message: dataImport.errorMessage, status: dataImport.status, kind: 'upload' });
			if (removeOnFail) {
				await this.delete();
			}
			if (raiseOnFail) {
				throw error;
			}
		}
	}

	/**
	 * Deletes the upload.
	 * @returns {Promise<void>}
	 */
	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Inserts rows into a `stream` upload.
	 *
	 * @param {[rows: Record<string, any>[]] | [options: {rows: Record<string, any>[]}]} args
	 * @returns {Promise<Record<string, any>>} The API's response
	 */
	async insertRows(...args) {
		const { rows } = parseArgs(args, ['rows']);
		if (!Array.isArray(rows)) {
			throw new ValueError('rows must be an array of row objects');
		}
		return makeRequest({ method: 'POST', path: `${this.uri}/rows`, payload: { rows } });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Variable}
	 */
	variable(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Variable(name, { upload: this });
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Variable[]>}
	 */
	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { upload: this, properties: variable }));
	}

	/** @protected */
	async _getReadInfo() {
		await this.get();
		if (this.properties.status !== 'completed') {
			throw new ValueError(
				`The upload can't be read until it has been imported (its status is ${this.properties.status})`,
			);
		}
		return { numRows: this.properties.numRows, numBytes: this.properties.numBytes, canListRows: false };
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}

function uploadUri(table, name) {
	return `${table.uri}/uploads/${encodeURIComponent(name.replaceAll('.', '_'))}`;
}
