import { RecordBatchReader, Table as ArrowTable } from 'apache-arrow';
import Directory from '../classes/Directory.js';
import File from '../classes/File.js';
import { makeRequest } from './apiRequest.js';
import { isNode } from './node.js';
import { toRowsArray } from './rowsArray.js';

// Directories are cached by the URI and variables they were listed with, so that repeated listings of an unchanged
//   table don't need to be downloaded (or parsed) again
const cachedDirectories = new Map();

/**
 * Lists the files of a file index table (or query), as a Directory.
 *
 * @param {object} options
 * @param {import('../classes/Table.js').default} [options.table]
 * @param {import('../classes/Query.js').default} [options.query]
 * @returns {Promise<Directory>}
 */
export async function listDirectory({ table, query, fileIdVariable, fileNameVariable, signal }) {
	const uri = (table || query).uri;
	const cacheKey = JSON.stringify([uri, fileIdVariable, fileNameVariable]);
	const cached = cachedDirectories.get(cacheKey);
	// Query results never change
	if (cached && query) {
		return cached.directory;
	}

	const response = await makeRequest({
		method: 'GET',
		path: `${uri}/rawFiles`,
		query: { format: 'arrow', fileIdVariable, fileNameVariable },
		parseResponse: false,
		signal,
		// In Node, ask whether the listing changed. Browsers don't allow setting If-Modified-Since cross-origin, so their
		//   HTTP cache revalidates the response instead (which we can tell from its unchanged Last-Modified header).
		headers: isNode && cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : undefined,
		cache: isNode ? undefined : 'no-cache',
	});
	const lastModified = response.headers.get('last-modified');
	if (cached && (response.status === 304 || (lastModified && lastModified === cached.lastModified))) {
		await response.body?.cancel();
		cached.cachedAt = Date.now();
		return cached.directory;
	}

	const reader = await RecordBatchReader.from(response.body);
	const batches = [];
	for await (const batch of reader) {
		batches.push(batch);
	}
	const rows = batches.length ? await toRowsArray(new ArrowTable(batches), { temporal: false }) : [];

	const directory = new Directory({ path: '/', table, query });
	for (const row of rows) {
		directory._addFile(
			new File(row.file_id, row[fileNameVariable || 'file_name'], { table, query, properties: row, directory }),
		);
	}
	cachedDirectories.set(cacheKey, { directory, lastModified, cachedAt: Date.now() });
	return directory;
}

// A directory listed within the last `maxAge` milliseconds, if any
export function getRecentDirectory({ table, query, maxAge }) {
	const cached = cachedDirectories.get(JSON.stringify([(table || query).uri, undefined, undefined]));
	return cached && (query || Date.now() - cached.cachedAt < maxAge) ? cached.directory : null;
}
