import { makeRequest, sleep } from './apiRequest.js';
import { APIError, NetworkError, RedivisError, ValueError } from './errors.js';
import { importNodeModule, requireNode } from './node.js';
import { mapConcurrent } from './pool.js';

const MAX_RETRIES = 10;

// The destination of a single file: a file path, or a directory (that exists, or ends with a separator) to download it
//   into. Defaults to the current working directory.
export async function resolveDownloadPath(path, fileName) {
	requireNode('Downloading files');
	const [nodePath, { stat }] = await Promise.all([importNodeModule('path'), importNodeModule('fs/promises')]);
	if (path === undefined || path === null) {
		return nodePath.resolve(fileName);
	}
	path = expandHome(path, await importNodeModule('os'));
	const isDirectory =
		/[\\/]$/.test(path) ||
		(await stat(path).then(
			(stats) => stats.isDirectory(),
			() => false,
		));
	return isDirectory ? nodePath.resolve(path, fileName) : nodePath.resolve(path);
}

export function expandHome(path, os) {
	return path.replace(/^~(?=$|[\\/])/, os.homedir());
}

/**
 * Downloads many files (in Node) into a directory, at their relative paths within it.
 *
 * @param {{uri: string, query?: object, relativePath: string, size?: number, md5Hash?: string}[]} files
 * @param {object} options
 * @param {string} [options.path] The directory to download into. Defaults to `defaultDirectoryName`, in the current
 *   working directory.
 * @returns {Promise<string[]>} The paths of the downloaded files
 */
export async function downloadFiles(
	files,
	{ path, defaultDirectoryName, overwrite, maxParallelization, onProgress, signal },
) {
	requireNode('Downloading files');
	const [nodePath, os, { mkdir, stat }] = await Promise.all([
		importNodeModule('path'),
		importNodeModule('os'),
		importNodeModule('fs/promises'),
	]);
	const directory = nodePath.resolve(
		path === undefined || path === null ? defaultDirectoryName : expandHome(path, os),
	);
	const existing = await stat(directory).catch(() => null);
	if (existing && !existing.isDirectory()) {
		throw new ValueError(`"${directory}" is a file, not a directory`);
	}
	await mkdir(directory, { recursive: true });

	const totalBytes = files.reduce((total, { size }) => total + (size ?? 0), 0);
	let bytesDownloaded = 0;
	let filesDownloaded = 0;
	const report = () => onProgress?.({ bytesDownloaded, totalBytes, filesDownloaded, totalFiles: files.length });

	return mapConcurrent(
		files,
		maxParallelization,
		async ({ relativePath, ...file }) => {
			const filePath = nodePath.join(directory, ...relativePath.split('/'));
			if (!filePath.startsWith(directory + nodePath.sep)) {
				throw new ValueError(`The file path "${relativePath}" is outside of the download directory`);
			}
			let fileBytes = 0;
			await downloadFile({
				...file,
				filePath,
				overwrite,
				signal,
				onProgress: (bytes) => {
					bytesDownloaded += bytes - fileBytes;
					fileBytes = bytes;
					report();
				},
			});
			filesDownloaded++;
			report();
			return filePath;
		},
		{ signal },
	);
}

/**
 * Downloads a single file (in Node). It's written to a temporary file alongside the destination, which replaces the
 * destination once it's complete and verified. An existing file with the same size and MD5 hash is left as is.
 *
 * @param {object} options
 * @param {string} options.uri The API path to download from
 * @param {object} [options.query] Query parameters for the download
 * @param {string} options.filePath
 * @param {number} [options.size] The expected size, if known
 * @param {string} [options.md5Hash] The expected base64 MD5 hash, if known. Otherwise, the hash the server reports is
 *   used.
 * @param {boolean} [options.overwrite]
 * @param {(bytesDownloaded: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function downloadFile({ uri, query, filePath, size, md5Hash, overwrite, onProgress, signal }) {
	requireNode('Downloading files');
	const [nodePath, fs, { createHash }] = await Promise.all([
		importNodeModule('path'),
		importNodeModule('fs/promises'),
		importNodeModule('crypto'),
	]);

	if (await isExistingFile(fs, filePath)) {
		if (size !== undefined && md5Hash && (await hashFile(fs, createHash, filePath, size)) === md5Hash) {
			onProgress?.(size);
			return;
		}
		if (!overwrite) {
			throw new ValueError(`A file already exists at "${filePath}". Set overwrite to true to replace it.`);
		}
	}
	await fs.mkdir(nodePath.dirname(filePath), { recursive: true });

	const partialPath = `${filePath}.redivis-partial`;
	const handle = await fs.open(partialPath, 'w');
	let offset = 0;
	let hash = createHash('md5');
	let didRestartForHash = false;

	try {
		for (let retryCount = 0; ;) {
			try {
				const response = await makeRequest({
					method: 'GET',
					path: uri,
					query,
					parseResponse: false,
					signal,
					headers: offset ? { Range: `bytes=${offset}-` } : undefined,
				});

				// A response that doesn't resume where we left off starts over
				const resumedAt = response.status === 206 ? parseContentRangeStart(response) : 0;
				if (resumedAt !== offset) {
					offset = 0;
					hash = createHash('md5');
					await handle.truncate(0);
					if (resumedAt !== 0) {
						await response.body?.cancel();
						continue;
					}
				}
				// A response that's decompressed in transit can't be checked against the stored file's size and hash
				const isEncoded = !!response.headers.get('content-encoding');
				size ??= parseTotalSize(response);
				md5Hash ??= parseMd5Header(response);

				for await (const chunk of response.body) {
					await handle.write(chunk, 0, chunk.length, offset);
					hash.update(chunk);
					offset += chunk.length;
					retryCount = 0;
					onProgress?.(offset);
				}

				if (!isEncoded && size !== undefined && offset !== size) {
					throw new NetworkError(`The download ended after ${offset} of ${size} bytes`);
				}
				if (!isEncoded && md5Hash && hash.digest('base64') !== md5Hash) {
					if (didRestartForHash) {
						throw new RedivisError(
							`The downloaded file's MD5 hash doesn't match the expected hash (${md5Hash})`,
						);
					}
					// Try once more from scratch, in case the data was corrupted in transit
					didRestartForHash = true;
					offset = 0;
					hash = createHash('md5');
					await handle.truncate(0);
					continue;
				}
				break;
			} catch (e) {
				const isRetryable =
					e instanceof TypeError ||
					e instanceof NetworkError ||
					(e instanceof APIError && (e.status === 429 || e.status >= 500));
				if (signal?.aborted || !isRetryable) {
					throw e;
				}
				if (++retryCount > MAX_RETRIES) {
					throw new NetworkError(`Downloading "${filePath}" failed after ${MAX_RETRIES} retries`, {
						cause: e,
					});
				}
				await sleep(retryCount * 1000, signal);
			}
		}
		await handle.close();
		await fs.rename(partialPath, filePath);
	} catch (e) {
		await handle.close().catch(() => {});
		await fs.rm(partialPath, { force: true });
		throw e;
	}
}

async function isExistingFile(fs, filePath) {
	const stats = await fs.stat(filePath).catch(() => null);
	if (stats?.isDirectory()) {
		throw new ValueError(`"${filePath}" is a directory`);
	}
	return !!stats;
}

// The base64 MD5 hash of a local file, or null if its size doesn't match
async function hashFile(fs, createHash, filePath, size) {
	const handle = await fs.open(filePath);
	try {
		if ((await handle.stat()).size !== size) {
			return null;
		}
		const hash = createHash('md5');
		for await (const chunk of handle.createReadStream()) {
			hash.update(chunk);
		}
		return hash.digest('base64');
	} finally {
		await handle.close();
	}
}

function parseContentRangeStart(response) {
	const match = response.headers.get('content-range')?.match(/bytes (\d+)-/);
	return match ? Number(match[1]) : 0;
}

function parseTotalSize(response) {
	const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
	if (total) {
		return Number(total);
	}
	const length = response.headers.get('content-length');
	// A compressed response's length is that of the compressed body, not the file
	return length && !response.headers.get('content-encoding') ? Number(length) : undefined;
}

// The MD5 hash, from a Content-Digest ("md5=:<base64>:") or x-goog-hash ("md5=<base64>") header
function parseMd5Header(response) {
	const digest = response.headers.get('content-digest')?.match(/md5=:([^:]+):/i)?.[1];
	return digest ?? response.headers.get('x-goog-hash')?.match(/md5=([^,\s]+)/i)?.[1] ?? undefined;
}
