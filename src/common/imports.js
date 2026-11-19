import { makeRequest, sleep } from './apiRequest.js';
import { getRequestBaseUrl } from './auth.js';
import { APIError, JobError, NetworkError } from './errors.js';
import { bytesToBase64, createMd5Hash } from './md5.js';
import { definedValues } from './references.js';

// Data is uploaded to a table through an import (`/imports/:id`): it's created, its files are uploaded to it, and it's
//   finalized, after which it's processed in the background.

const MiB = 2 ** 20;

/**
 * Tunable limits for uploading an import's files. They're properties of an object (rather than constants) so that the
 * tests can lower them.
 */
export const IMPORT_SETTINGS = {
	// Larger files are uploaded through a resumable upload session, in chunks; smaller ones in a single request
	directUploadMaxBytes: 32 * MiB,
	// Chunk sizes adapt to throughput, staying a power-of-two number of MiB, since GCS requires chunks (but the last)
	//   to be multiples of 256KiB
	minChunkBytes: MiB,
	startChunkBytes: 8 * MiB,
	maxChunkBytes: 128 * MiB,
	// The size of each read when hashing a file, so that a file is never read into memory all at once
	hashReadBytes: 8 * MiB,
	// Each retry of a chunk waits this much longer than the last
	retryDelayMs: 1000,
	// An import is polled at this interval, which grows by half each time up to the maximum
	pollIntervalMs: 2000,
	maxPollIntervalMs: 30_000,
};

// Consecutive failures (without progress) of an upload session's chunks before giving up
const MAX_RETRIES = 10;
// The number of times a file's session can be replaced. A session also dies if the file fails its MD5 check on
//   completion (e.g., it changed while it was uploaded), which uploading it again is unlikely to fix.
const MAX_SESSION_REPLACEMENTS = 3;
// The responses to a chunk (or a status query) from a session that can no longer be used: it was cancelled, expired,
//   or failed its checks on completion
const DEAD_SESSION_STATUSES = [400, 404, 410, 499];
const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

/**
 * Creates an import into a table. The request carries an idempotency key, so that a retry can't create two imports.
 *
 * @param {string} tableUri The table's URI for writing (never one scoped to a workflow)
 * @param {Record<string, any>} payload The import's properties; undefined and null ones aren't sent
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>} The import
 */
export async function createImport(tableUri, payload, { signal } = {}) {
	return makeRequest({
		method: 'POST',
		path: `${tableUri}/imports`,
		// Generated once, so that every retry of this request carries the same key
		payload: Object.fromEntries(
			Object.entries({ idempotencyKey: globalThis.crypto.randomUUID(), ...payload }).filter(
				([, value]) => value !== undefined && value !== null,
			),
		),
		idempotent: true,
		signal,
	});
}

/**
 * Uploads a file to an import: in a single request if it's small enough, and otherwise in chunks, through a resumable
 * upload session.
 *
 * @param {{uri: string}} dataImport
 * @param {string} name The file's name
 * @param {{source: {read: (start: number, end: number) => Promise<Blob | Uint8Array>, rereadable?: boolean}, size: number}} content
 *   As from resolveContent()
 * @param {object} [options]
 * @param {string} [options.md5Hash] The content's base64 MD5 hash; computed if not given
 * @param {(bytesUploaded: number) => void} [options.onProgress] Called with the number of bytes committed so far
 * @param {AbortSignal} [options.signal]
 */
export async function uploadImportFile(dataImport, name, content, { md5Hash, onProgress, signal } = {}) {
	md5Hash ??= await computeMd5Base64(content, { signal });
	const fileUri = `${dataImport.uri}/files/${encodeImportFileName(name)}`;
	if (content.size <= IMPORT_SETTINGS.directUploadMaxBytes) {
		const response = await makeRequest({
			method: 'POST',
			path: fileUri,
			// A Blob (or a buffer), so that it can be sent again on a retry
			body: await content.source.read(0, content.size),
			// fetch sets Content-Length from the body (browsers don't allow setting it)
			headers: definedValues({ 'Content-Type': 'application/octet-stream', 'Content-MD5': md5Hash }),
			parseResponse: false,
			idempotent: true,
			signal,
		});
		await response.body?.cancel();
	} else {
		await uploadThroughSession(fileUri, content, { md5Hash, onProgress, signal });
	}
	onProgress?.(content.size);
}

// Uploads a file in chunks through a resumable upload session, which the API opens, and to which the chunks are sent
//   without credentials (the session's upload_id grants access to it alone)
async function uploadThroughSession(fileUri, { source, size }, { md5Hash, onProgress, signal }) {
	const openSession = async () => {
		const session = await makeRequest({
			method: 'POST',
			path: `${fileUri}/uploadSession`,
			payload: definedValues({ size, md5Hash }),
			idempotent: true,
			signal,
		});
		return session.uri;
	};
	const baseUrl = getRequestBaseUrl();

	let sessionUri = await openSession();
	let sessionReplacements = 0;
	let chunkSize = IMPORT_SETTINGS.startChunkBytes;
	let failures = 0;
	let committed = 0;
	// Unknown until the session says, since it may be a resumed one that already has some of the file
	let start = null;

	while (true) {
		const startedAt = Date.now();
		const end = start === null ? null : Math.min(start + chunkSize, size);
		let nowCommitted;
		try {
			nowCommitted = await putToSession(`${baseUrl}${sessionUri}`, size, {
				// A status query, with no body, asks the session how much it has
				range: start === null ? `bytes */${size}` : `bytes ${start}-${end - 1}/${size}`,
				body: start === null ? undefined : await source.read(start, end),
				signal,
			});
		} catch (e) {
			if (signal?.aborted) throw e;
			if (e instanceof APIError && DEAD_SESSION_STATUSES.includes(e.status)) {
				// The API replaces a session that can't be used, unless the import can no longer accept files
				const newSessionUri = await openSession();
				if (newSessionUri === sessionUri) {
					throw new APIError({
						status: e.status,
						code: 'upload_failed',
						description:
							"The file's upload session ended, and the import can no longer accept files (imports must be " +
							`finalized within 20 hours of being created): ${e.description}`,
					});
				}
				if (++sessionReplacements > MAX_SESSION_REPLACEMENTS) {
					throw new APIError({
						status: e.status,
						code: 'upload_failed',
						description: `The upload failed on ${MAX_SESSION_REPLACEMENTS + 1} upload sessions: ${e.description}`,
					});
				}
				// The new session starts from nothing
				sessionUri = newSessionUri;
				committed = 0;
				failures = 0;
				start = null;
				continue;
			}
			if (!isRetryable(e)) throw e;
			if (++failures > MAX_RETRIES) {
				throw new NetworkError(`Upload failed after ${MAX_RETRIES} retries`, { cause: e });
			}
			await sleep(failures * IMPORT_SETTINGS.retryDelayMs, signal);
			chunkSize = Math.max(IMPORT_SETTINGS.minChunkBytes, chunkSize / 2);
			start = null;
			continue;
		}

		if (nowCommitted > committed) {
			failures = 0;
		} else if (start !== null && ++failures > MAX_RETRIES) {
			throw new NetworkError(`The upload made no progress after ${MAX_RETRIES} attempts`);
		}
		if (nowCommitted >= size) {
			return;
		}
		if (nowCommitted !== committed) {
			onProgress?.(nowCommitted);
		}
		committed = nowCommitted;

		if (start !== null) {
			const elapsed = Date.now() - startedAt;
			if (elapsed > 8000 && chunkSize > IMPORT_SETTINGS.minChunkBytes) {
				chunkSize /= 2;
			} else if (elapsed < 4000 && chunkSize < IMPORT_SETTINGS.maxChunkBytes) {
				chunkSize *= 2;
			}
		}
		// Continue from what the session committed, rather than from what was sent
		start = committed;
	}
}

// Sends a chunk (or a status query) to an upload session, returning the number of bytes it has committed. No
//   credentials are sent, deliberately.
async function putToSession(url, size, { range, body, signal }) {
	const response = await fetch(url, { method: 'PUT', headers: { 'Content-Range': range }, body, signal });
	// Complete
	if (response.status === 200 || response.status === 201) {
		await response.body?.cancel();
		return size;
	}
	// Incomplete, with the bytes committed so far in the Range header, which is missing if there are none yet
	if (response.status === 308) {
		await response.body?.cancel();
		const committedRange = response.headers.get('range')?.match(/bytes=0-(\d+)/);
		return committedRange ? Number(committedRange[1]) + 1 : 0;
	}
	throw new APIError({ status: response.status, code: 'upload_failed', description: await response.text() });
}

function isRetryable(e) {
	if (e instanceof APIError) {
		return e.status === 408 || e.status === 429 || e.status >= 500;
	}
	// Network failures surface as TypeErrors from fetch
	return e instanceof TypeError || e instanceof NetworkError;
}

/**
 * Finalizes an import, once all of its files are uploaded, after which it's processed.
 * @param {{uri: string}} dataImport
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>} The import
 */
export async function finalizeImport(dataImport, { signal } = {}) {
	return makeRequest({ method: 'POST', path: `${dataImport.uri}/finalize`, idempotent: true, signal });
}

/**
 * Waits for an import to finish, polling it with a growing interval.
 *
 * @param {Record<string, any>} dataImport The import, as last returned by the API
 * @param {object} [options]
 * @param {boolean} [options.raiseOnFail=true] Throw a JobError if the import failed or was cancelled
 * @param {string} [options.kind='upload'] The kind of job, for the JobError
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Record<string, any>>} The finished import
 */
export async function waitForImport(dataImport, { raiseOnFail = true, kind = 'upload', signal } = {}) {
	let interval = IMPORT_SETTINGS.pollIntervalMs;
	while (!FINISHED_STATUSES.includes(dataImport.status)) {
		await sleep(interval, signal);
		dataImport = await makeRequest({ method: 'GET', path: dataImport.uri, idempotent: true, signal });
		interval = Math.min(interval * 1.5, IMPORT_SETTINGS.maxPollIntervalMs);
	}
	if (raiseOnFail && dataImport.status !== 'completed') {
		throw new JobError({ message: dataImport.errorMessage, status: dataImport.status, kind });
	}
	return dataImport;
}

/**
 * Encodes a file name for an import's file paths: the unpadded base64url encoding of its UTF-8 bytes.
 * @param {string} name
 */
export function encodeImportFileName(name) {
	return bytesToBase64(new TextEncoder().encode(name)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The base64 MD5 hash of content (as from resolveContent()), read in pieces so that it's never all in memory. A stream
 * can only be read once, so its hash is only computed when it's small enough to be uploaded in a single request (for
 * which it's held in memory anyway); otherwise, this returns undefined, and the upload isn't verified.
 *
 * @param {{source: {read: (start: number, end: number) => Promise<Blob | Uint8Array>, rereadable?: boolean}, size: number}} content
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<string | undefined>}
 */
export async function computeMd5Base64({ source, size }, { signal } = {}) {
	const readBytes = source.rereadable ? IMPORT_SETTINGS.hashReadBytes : size;
	if (!source.rereadable && size > IMPORT_SETTINGS.directUploadMaxBytes) {
		return undefined;
	}
	const hash = await createMd5Hash();
	for (let start = 0; start < size; start += readBytes) {
		signal?.throwIfAborted();
		const data = await source.read(start, Math.min(start + readBytes, size));
		hash.update(data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()));
	}
	return hash.digest();
}
