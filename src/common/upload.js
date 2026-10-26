import { makeRequest, sleep } from './apiRequest.js';
import { isPlainObject } from './args.js';
import { APIError, NetworkError, ValueError } from './errors.js';
import { importNodeModule, requireNode } from './node.js';
import { jsonReplacer } from './json.js';
import { toRowsArray } from './rowsArray.js';
import { Table as ArrowTable } from 'apache-arrow';

// Larger uploads use GCS's resumable protocol, in chunks, so that they can be resumed and report progress
export const RESUMABLE_UPLOAD_MIN_BYTES = 2 ** 23; // 8MB
// Chunk sizes adapt to throughput. GCS requires them to be multiples of 256KiB.
const MIN_CHUNK_BYTES = 2 ** 20; // 1MB
const START_CHUNK_BYTES = 2 ** 23; // 8MB
const MAX_CHUNK_BYTES = 2 ** 27; // 128MB
const MAX_RETRIES = 10;

/**
 * Normalizes the content of an upload or file to `{ source, size, name, type }`, where `source.read(start, end)` reads
 * a range of its bytes.
 *
 * Accepts a Blob or File; an ArrayBuffer or typed array; a ReadableStream (with `size`); a file path (in Node); or
 * tabular data (an array of row objects, or an arrow Table), which is serialized as newline-delimited JSON.
 */
export async function resolveContent(content, { size, name } = {}) {
	if (typeof content === 'string') {
		requireNode('Uploading from a file path');
		const [{ openAsBlob }, path] = await Promise.all([importNodeModule('fs'), importNodeModule('path')]);
		const blob = await openAsBlob(content);
		return { source: blobSource(blob), size: blob.size, name: name ?? path.basename(content) };
	}
	if (typeof Blob !== 'undefined' && content instanceof Blob) {
		return { source: blobSource(content), size: content.size, name: name ?? content.name };
	}
	if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
		const blob = new Blob([content]);
		return { source: blobSource(blob), size: blob.size, name };
	}
	if (content instanceof ReadableStream) {
		if (!Number.isInteger(size) || size < 0) {
			throw new ValueError('The size of a ReadableStream must be provided, with the `size` option');
		}
		return { source: streamSource(content, size), size, name };
	}
	if (Array.isArray(content) || content instanceof ArrowTable) {
		const blob = await toNdjsonBlob(content);
		return { source: blobSource(blob), size: blob.size, name, type: 'jsonl' };
	}
	throw new ValueError(
		'Content must be a Blob, File, ArrayBuffer, typed array, ReadableStream, file path (in Node), array of row ' +
			'objects, or arrow Table',
	);
}

// Serializes rows (or an arrow Table) as newline-delimited JSON
async function toNdjsonBlob(data) {
	const rows = data instanceof ArrowTable ? await toRowsArray(data, { bigInt: true }) : data;
	const lines = rows.map((row, i) => {
		if (!isPlainObject(row)) {
			throw new ValueError(`Each row must be an object, but row ${i} is ${row === null ? 'null' : typeof row}`);
		}
		return JSON.stringify(row, jsonReplacer);
	});
	return new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
}

function blobSource(blob) {
	return { read: async (start, end) => blob.slice(start, end) };
}

// Reads a stream as consecutive ranges. Data before the most recent range is discarded, but the current range is kept,
//   so that it can be read again if uploading it fails (GCS never asks for bytes before the last range it acknowledged).
function streamSource(stream, size) {
	const reader = stream.getReader();
	let buffer = new Uint8Array(0);
	let bufferStart = 0;

	return {
		async read(start, end) {
			if (start < bufferStart) {
				throw new ValueError("Can't re-read data that was already discarded from the stream");
			}
			buffer = buffer.subarray(start - bufferStart);
			bufferStart = start;
			while (bufferStart + buffer.length < end) {
				const { done, value } = await reader.read();
				if (done) {
					throw new ValueError(
						`The stream ended after ${bufferStart + buffer.length} bytes, before its size (${size})`,
					);
				}
				const combined = new Uint8Array(buffer.length + value.length);
				combined.set(buffer);
				combined.set(value, buffer.length);
				buffer = combined;
			}
			return buffer.slice(0, end - start);
		},
	};
}

/**
 * Creates temporary upload locations for files of the given sizes, within a table.
 * @returns {Promise<{id: string, url: string, resumable: boolean}[]>}
 */
export async function createTempUploads(tableUri, files, { signal } = {}) {
	const { results } = await makeRequest({
		method: 'POST',
		path: `${tableUri}/tempUploads`,
		signal,
		payload: {
			tempUploads: files.map(({ size, name }) => ({
				size,
				name: name || randomId(),
				resumable: size > RESUMABLE_UPLOAD_MIN_BYTES,
			})),
		},
	});
	return results;
}

/**
 * Uploads content to a temporary upload location, as returned by createTempUploads().
 *
 * @param {{url: string, resumable: boolean}} tempUpload
 * @param {{source: object, size: number}} content
 * @param {object} [options]
 * @param {(bytesUploaded: number) => void} [options.onProgress] Called with the total number of bytes uploaded so far
 * @param {AbortSignal} [options.signal]
 */
export async function uploadToTempUpload(tempUpload, content, { onProgress, signal } = {}) {
	if (tempUpload.resumable) {
		await resumableUpload(tempUpload.url, content, { onProgress, signal });
	} else {
		await withRetries(async () => {
			const body = await content.source.read(0, content.size);
			const res = await fetch(tempUpload.url, { method: 'PUT', body, signal });
			await checkUploadResponse(res);
		}, signal);
	}
	onProgress?.(content.size);
}

async function resumableUpload(url, { source, size }, { onProgress, signal }) {
	let sessionUrl = await withRetries(() => initiateResumableUpload(url, size, signal), signal);
	let start = 0;
	let chunkSize = START_CHUNK_BYTES;
	let retryCount = 0;

	while (true) {
		if (start >= size) {
			return;
		}
		const end = Math.min(start + chunkSize, size);
		const startedAt = Date.now();
		let committed;
		try {
			const res = await fetch(sessionUrl, {
				method: 'PUT',
				headers: { 'Content-Range': `bytes ${start}-${end - 1}/${size}` },
				body: await source.read(start, end),
				signal,
			});
			committed = await getCommittedBytes(res, size);
		} catch (e) {
			if (signal?.aborted || !isRetryable(e)) throw e;
			if (++retryCount > MAX_RETRIES) {
				throw new NetworkError(`Upload failed after ${MAX_RETRIES} retries`, { cause: e });
			}
			await sleep(retryCount * 1000, signal);
			chunkSize = Math.max(MIN_CHUNK_BYTES, chunkSize / 2);
			// Ask GCS how much it received, and continue from there
			try {
				const res = await fetch(sessionUrl, {
					method: 'PUT',
					headers: { 'Content-Range': `bytes */${size}` },
					signal,
				});
				committed = await getCommittedBytes(res, size);
			} catch (probeError) {
				if (signal?.aborted) throw probeError;
				if (probeError.status === 404 || probeError.status === 410) {
					// The upload session expired, so start a new one
					sessionUrl = await withRetries(() => initiateResumableUpload(url, size, signal), signal);
					committed = 0;
				} else {
					// Try the probe again on the next iteration
					committed = start;
				}
			}
			start = committed;
			continue;
		}

		retryCount = 0;
		start = committed;
		if (start < size) {
			onProgress?.(start);
		}
		const elapsed = Date.now() - startedAt;
		if (elapsed > 8000 && chunkSize > MIN_CHUNK_BYTES) {
			chunkSize /= 2;
		} else if (elapsed < 4000 && chunkSize < MAX_CHUNK_BYTES) {
			chunkSize *= 2;
		}
	}
}

// Starts a resumable upload session, returning its URL
async function initiateResumableUpload(url, size, signal) {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'x-goog-resumable': 'start', 'x-upload-content-length': String(size) },
		signal,
	});
	await checkUploadResponse(res);
	const location = res.headers.get('location');
	if (!location) {
		throw new NetworkError(
			"The upload session couldn't be started, since its location wasn't readable (this may be a CORS issue)",
		);
	}
	return new URL(location, url).href;
}

// How many bytes of a resumable upload GCS has committed, given its response to a chunk or a status check: the whole
//   upload when it's complete (200/201), or the end of the Range header when it's incomplete (308)
async function getCommittedBytes(res, size) {
	if (res.status === 200 || res.status === 201) {
		await res.body?.cancel();
		return size;
	}
	if (res.status === 308) {
		await res.body?.cancel();
		const range = res.headers.get('range');
		// GCS omits the header if it hasn't received any bytes
		return range ? Number(range.match(/bytes=0-(\d+)/)[1]) + 1 : 0;
	}
	await checkUploadResponse(res);
	throw new NetworkError(`Unexpected response status ${res.status} for a resumable upload`);
}

async function checkUploadResponse(res) {
	if (res.ok) {
		await res.body?.cancel();
		return;
	}
	throw new APIError({ status: res.status, code: 'upload_failed', description: await res.text() });
}

function isRetryable(e) {
	if (e instanceof APIError) {
		return e.status === 408 || e.status === 429 || e.status >= 500;
	}
	// Network failures surface as TypeErrors from fetch
	return e instanceof TypeError || e instanceof NetworkError;
}

async function withRetries(fn, signal) {
	for (let retryCount = 0; ; retryCount++) {
		try {
			return await fn();
		} catch (e) {
			if (signal?.aborted || !isRetryable(e)) throw e;
			if (retryCount >= MAX_RETRIES) {
				throw new NetworkError(`Upload failed after ${MAX_RETRIES} retries`, { cause: e });
			}
			await sleep((retryCount + 1) * 1000, signal);
		}
	}
}

export function randomId() {
	return globalThis.crypto.randomUUID();
}

// Resolves the files to add to a file index table, from a local directory (in Node) or a list of file specifications
export async function resolveFiles({ files, directory }) {
	if ((files === undefined) === (directory === undefined)) {
		throw new ValueError('Exactly one of `files` or `directory` must be provided');
	}
	if (directory !== undefined) {
		requireNode('Uploading a directory');
		const { readdir } = await importNodeModule('fs/promises');
		const path = await importNodeModule('path');
		const entries = await readdir(directory, { recursive: true, withFileTypes: true });
		const filePaths = entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
			// Like a shell glob, skip hidden files and directories (e.g., .DS_Store)
			.filter(
				(filePath) =>
					!path
						.relative(directory, filePath)
						.split(path.sep)
						.some((part) => part.startsWith('.')),
			)
			.sort();
		return Promise.all(
			filePaths.map(async (filePath) => ({
				...(await resolveContent(filePath)),
				name: path.relative(directory, filePath).split(path.sep).join('/'),
			})),
		);
	}

	if (!Array.isArray(files) && !(typeof FileList !== 'undefined' && files instanceof FileList)) {
		throw new ValueError('`files` must be an array');
	}
	return Promise.all(
		[...files].map(async (file) => {
			if (typeof file === 'string') {
				return resolveContent(file);
			}
			if (typeof File !== 'undefined' && file instanceof File) {
				// Files picked from a directory keep their path within it
				return resolveContent(file, { name: file.webkitRelativePath || file.name });
			}
			if (isPlainObject(file)) {
				const { path, data, name } = file;
				if (path !== undefined) {
					return resolveContent(path, { name });
				}
				if (!name) {
					throw new ValueError('Every file specified with `data` must also have a `name`');
				}
				return resolveContent(typeof data === 'string' ? new TextEncoder().encode(data) : data, { name });
			}
			const resolved = await resolveContent(file);
			if (!resolved.name) {
				throw new ValueError('Every file must have a name; pass { name, data } for content without one');
			}
			return resolved;
		}),
	);
}
