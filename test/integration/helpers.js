// Helpers for working with a live Redivis API.
import { sortedBy } from './data.js';

/**
 * Runs `fn`, retrying while the API refuses it because a dataset's release (or unrelease) is still in progress (e.g., to
 * unrelease or delete a dataset that was just released).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function retryWhileReleasing(fn, { timeout = 5 * 60 * 1000 } = {}) {
	const deadline = Date.now() + timeout;
	while (true) {
		try {
			return await fn();
		} catch (e) {
			if (!/process of being (un)?released/.test(e.message) || Date.now() > deadline) {
				throw e;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}
}

/**
 * Gives a dataset some data, which it needs before it can be released.
 * @param {import('../../src/classes/Dataset.js').default} dataset
 */
export async function addData(dataset, tableName = 'data') {
	const table = await dataset.table(tableName).create();
	await table.upload('data.csv').create(new TextEncoder().encode('a\n1\n'));
	return table;
}

/**
 * Reads a table, query, or upload's rows, sorted by a variable.
 * @param {import('../../src/classes/TabularReader.js').default} reader
 */
export async function readSorted(reader, key = 'id', options = {}) {
	return sortedBy(await reader.toRowsArray(options), key);
}

/**
 * The values of a variable across rows.
 * @param {Record<string, any>[]} rows
 * @param {string} name
 */
export function column(rows, name) {
	return rows.map((row) => row[name]);
}
