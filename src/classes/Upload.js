import TabularReader from './TabularReader.js';
import Variable from './Variable.js';
import { makePaginatedRequest, makeRequest, sleep } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { JobError, ValueError } from '../common/errors.js';
import { definedValues } from '../common/references.js';
import { createTempUploads, resolveContent, uploadToTempUpload } from '../common/upload.js';

export default class Upload extends TabularReader {
	/**
	 * An upload of data to a table, in the next version of its dataset.
	 *
	 * @param {string} [name] Defaults to the name of the uploaded file, if any
	 * @param {object} options
	 * @param {import('./Table.js').default} options.table
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name = '', table, properties } = parseArgs(args, ['name'], { allowed: ['table', 'properties'] });
		this.name = name;
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
	 * @param {Blob|File|ArrayBuffer|ArrayBufferView|ReadableStream|string|object[]|import('apache-arrow').Table} [content]
	 *   The data to upload: a Blob or File; an ArrayBuffer or typed array; a ReadableStream (with the `size` option); a
	 *   file path (in Node); or tabular data (an array of row objects, or an arrow Table), which is uploaded as
	 *   newline-delimited JSON. Omit for a `transferSpecification` or a `type: 'stream'` upload.
	 * @param {object} [options]
	 * @param {string} [options.type] The file type (e.g. `delimited`, `parquet`, `stream`). Inferred from the name if
	 *   not given.
	 * @param {number} [options.size] The size in bytes, required when `content` is a ReadableStream
	 * @param {object} [options.transferSpecification] Import the data from another source (e.g., a URL or a cloud
	 *   bucket), rather than uploading content
	 * @param {object[]} [options.schema] The variables of a `stream` upload
	 * @param {object} [options.metadata] Variable metadata, keyed by variable name
	 * @param {string} [options.delimiter]
	 * @param {boolean} [options.hasHeaderRow=true]
	 * @param {boolean} [options.skipBadRecords=false]
	 * @param {boolean} [options.hasQuotedNewlines]
	 * @param {string} [options.quoteCharacter]
	 * @param {string} [options.escapeCharacter]
	 * @param {string[]} [options.nullMarkers]
	 * @param {boolean} [options.allowJaggedRows=false]
	 * @param {boolean} [options.ifNotExists=false] Do nothing if an upload with this name already exists
	 * @param {boolean} [options.replaceOnConflict=false] Replace an existing upload with this name
	 * @param {boolean} [options.renameOnConflict=false] Give the upload a new name if one with this name exists
	 * @param {boolean} [options.waitForFinish=true] Wait for the data to be imported
	 * @param {boolean} [options.raiseOnFail=true] Throw a JobError if the import fails
	 * @param {boolean} [options.removeOnFail=false] Delete the upload if the import fails
	 * @param {(progress: {bytesUploaded: number, totalBytes: number}) => void} [options.onProgress]
	 * @param {AbortSignal} [options.signal]
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

		let tempUploadId;
		if (resolvedContent) {
			const { size } = resolvedContent;
			const [tempUpload] = await createTempUploads(this.table.uri, [{ size, name: this.name }], { signal });
			onProgress?.({ bytesUploaded: 0, totalBytes: size });
			await uploadToTempUpload(tempUpload, resolvedContent, {
				onProgress: (bytesUploaded) => onProgress?.({ bytesUploaded, totalBytes: size }),
				signal,
			});
			tempUploadId = tempUpload.id;
		}

		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${this.table.uri}/uploads`,
				signal,
				payload: definedValues({
					name: this.name,
					type,
					schema: options.schema,
					metadata: options.metadata,
					hasHeaderRow: options.hasHeaderRow,
					skipBadRecords: options.skipBadRecords,
					hasQuotedNewlines: options.hasQuotedNewlines,
					allowJaggedRows: options.allowJaggedRows,
					quoteCharacter: options.quoteCharacter,
					escapeCharacter: options.escapeCharacter,
					nullMarkers: options.nullMarkers,
					delimiter: options.delimiter,
					tempUploadId,
					transferSpecification: options.transferSpecification,
				}),
			}),
		);

		if ((tempUploadId || options.transferSpecification) && options.waitForFinish) {
			await this.#waitForImport(options);
		}
		return this;
	}

	async #waitForImport({ raiseOnFail, removeOnFail, signal }) {
		while (this.properties.status !== 'completed' && this.properties.status !== 'failed') {
			await sleep(2000, signal);
			await this.get();
		}
		if (this.properties.status === 'failed') {
			const error = new JobError({
				message: this.properties.errorMessage,
				status: this.properties.status,
				kind: 'upload',
			});
			if (removeOnFail) {
				await this.delete();
			}
			if (raiseOnFail) {
				throw error;
			}
		}
	}

	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Inserts rows into a `stream` upload.
	 * @param {object[]} rows
	 * @returns {Promise<object>} The API's response
	 */
	async insertRows(...args) {
		const { rows } = parseArgs(args, ['rows']);
		if (!Array.isArray(rows)) {
			throw new ValueError('rows must be an array of row objects');
		}
		return makeRequest({ method: 'POST', path: `${this.uri}/rows`, payload: { rows } });
	}

	variable(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Variable(name, { upload: this });
	}

	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { upload: this, properties: variable }));
	}

	async _getReadInfo() {
		await this.get();
		if (this.properties.status !== 'completed') {
			throw new ValueError(
				`The upload can't be read until it has been imported (its status is ${this.properties.status})`,
			);
		}
		return { numRows: this.properties.numRows, numBytes: this.properties.numBytes, canListRows: false };
	}

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}

function uploadUri(table, name) {
	return `${table.uri}/uploads/${encodeURIComponent(name.replaceAll('.', '_'))}`;
}
