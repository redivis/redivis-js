import { makeRequest, sleep } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { APIError, NetworkError, ValueError } from '../common/errors.js';
import { downloadFile, resolveDownloadPath } from '../common/download.js';

const MAX_RETRIES = 10;

export default class File {
	/**
	 * A file in a file index table (or query result), as listed by `toDirectory()` or `listFiles()`.
	 *
	 * @param {string} id
	 * @param {string} name The file's path within its table, e.g. `images/a.png`
	 * @param {object} options
	 * @param {import('./Directory.js').default} [options.directory]
	 * @param {import('./Table.js').default} [options.table]
	 * @param {import('./Query.js').default} [options.query]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		const {
			id,
			name,
			directory,
			table,
			query,
			properties = {},
		} = parseArgs(args, ['id', 'name'], {
			allowed: ['directory', 'table', 'query', 'properties'],
		});
		if (!table && !query) {
			throw new ValueError('A file must belong to a table or query');
		}
		this.id = id;
		this.path = name;
		this.name = name.split('/').pop();
		this.directory = directory;
		this.table = table;
		this.query = query;
		this.properties = properties;
		this.uri = `/rawFiles/${encodeURIComponent(id)}`;
	}

	/** @type {number|undefined} The file's size, in bytes */
	get size() {
		return this.properties.size ?? undefined;
	}

	/** @type {string|undefined} The base64-encoded MD5 hash of the file's contents */
	get md5Hash() {
		return this.properties.md5_hash ?? undefined;
	}

	/** @type {Date|undefined} */
	get addedAt() {
		return this.properties.added_at ?? undefined;
	}

	getProperty(property) {
		return this.properties[property];
	}

	toString() {
		return `<File ${this.path}>`;
	}

	toJSON() {
		return { id: this.id, path: this.path, ...this.properties };
	}

	/**
	 * Reads the file's contents (or a range of them) into memory.
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.asText=false] Decode the contents as UTF-8 text
	 * @param {number} [options.startByte=0]
	 * @param {number} [options.endByte] The last byte to read (inclusive). Defaults to the end of the file.
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<Uint8Array|string>}
	 */
	async read(...args) {
		const { asText, startByte, endByte, signal } = parseArgs(args, [], {
			defaults: { asText: false, startByte: 0 },
			allowed: ['endByte', 'signal'],
		});
		const response = new Response(this.stream({ startByte, endByte, signal }));
		return asText ? response.text() : new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * Streams the file's contents (or a range of them). Nothing is requested until the stream is read, and an
	 * interrupted download resumes where it left off.
	 *
	 * @param {object} [options]
	 * @param {number} [options.startByte=0]
	 * @param {number} [options.endByte] The last byte to read (inclusive). Defaults to the end of the file.
	 * @param {AbortSignal} [options.signal]
	 * @returns {ReadableStream<Uint8Array>}
	 */
	stream(...args) {
		const { startByte, endByte, signal } = parseArgs(args, [], {
			defaults: { startByte: 0 },
			allowed: ['endByte', 'signal'],
		});
		validateRange(startByte, endByte);
		const uri = this.uri;
		let offset = startByte;
		let reader;
		let retryCount = 0;
		// The number of bytes to discard, when the server ignores the requested range and starts from the beginning
		let skip = 0;

		const open = async () => {
			const isRanged = offset > 0 || endByte !== undefined;
			const response = await makeRequest({
				method: 'GET',
				path: uri,
				parseResponse: false,
				signal,
				headers: isRanged ? { Range: `bytes=${offset}-${endByte ?? ''}` } : undefined,
			});
			skip = isRanged && response.status !== 206 ? offset : 0;
			reader = response.body.getReader();
		};

		return new ReadableStream({
			async pull(controller) {
				while (true) {
					try {
						if (!reader) await open();
						let { done, value } = await reader.read();
						if (done) {
							controller.close();
							return;
						}
						if (skip) {
							const skipped = Math.min(skip, value.length);
							skip -= skipped;
							value = value.subarray(skipped);
						}
						if (endByte !== undefined && offset + value.length > endByte + 1) {
							value = value.subarray(0, endByte + 1 - offset);
						}
						if (!value.length) {
							if (endByte !== undefined && offset > endByte) {
								await reader.cancel();
								controller.close();
								return;
							}
							continue;
						}
						offset += value.length;
						retryCount = 0;
						controller.enqueue(value);
						return;
					} catch (e) {
						reader = undefined;
						if (signal?.aborted || e instanceof APIError || e instanceof ValueError) {
							throw e;
						}
						if (++retryCount > MAX_RETRIES) {
							throw new NetworkError(`Reading the file failed after ${MAX_RETRIES} retries`, {
								cause: e,
							});
						}
						await sleep(retryCount * 1000, signal);
					}
				}
			},
			async cancel(reason) {
				await reader?.cancel(reason);
			},
		});
	}

	/**
	 * Downloads the file (in Node). An existing file with the same contents is left as is.
	 *
	 * @param {string} [path] A file path, or a directory to download into (if it exists, or ends with a separator).
	 *   Defaults to the current working directory.
	 * @param {object} [options]
	 * @param {boolean} [options.overwrite=false] Replace an existing file with different contents
	 * @param {(progress: {bytesDownloaded: number, totalBytes?: number}) => void} [options.onProgress]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<string>} The path of the downloaded file
	 */
	async download(...args) {
		const { path, overwrite, onProgress, signal } = parseArgs(args, ['path'], {
			defaults: { overwrite: false },
			allowed: ['onProgress', 'signal'],
		});
		const filePath = await resolveDownloadPath(path, this.name);
		await downloadFile({
			uri: this.uri,
			filePath,
			size: this.size,
			md5Hash: this.md5Hash,
			overwrite,
			signal,
			onProgress: (bytesDownloaded) => onProgress?.({ bytesDownloaded, totalBytes: this.size }),
		});
		return filePath;
	}
}

function validateRange(startByte, endByte) {
	if (!Number.isInteger(startByte) || startByte < 0) {
		throw new ValueError('startByte must be a non-negative integer');
	}
	if (endByte !== undefined && (!Number.isInteger(endByte) || endByte < startByte)) {
		throw new ValueError('endByte must be an integer, no less than startByte');
	}
}
