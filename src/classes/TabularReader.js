import Base from './Base.js';
import { makePaginatedRequest, makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { ValueError } from '../common/errors.js';
import { isNode } from '../common/node.js';
import {
	DEFAULT_BROWSER_MAX_BYTES,
	LIST_ROWS_MAX_BYTES,
	MAX_PARALLELIZATION,
	getDefaultParallelization,
	listRowsSource,
	maxBytesError,
	readBatches,
	readStreamSource,
	readTable,
} from '../common/readRows.js';
import { toRowsArray } from '../common/rowsArray.js';

const iteratorOptions = ['variables', 'batchPreprocessor', 'onProgress', 'signal'];

// Shared row-reading methods of tables, queries, uploads, and read streams. Subclasses implement _getReadInfo().
export default class TabularReader extends Base {
	/**
	 * Streams the rows as arrow RecordBatches, which can be consumed with `for await`. Nothing is read until iteration
	 * starts, and breaking out of the loop stops the read. Batches from parallel streams arrive in no particular order.
	 *
	 * @param {number} [maxResults] The maximum number of rows to read
	 * @param {object} [options]
	 * @param {string[]} [options.variables] The variables to read, in order. Defaults to all.
	 * @param {number} [options.maxParallelization] The number of streams to read in parallel (at most 8)
	 * @param {(batch: import('apache-arrow').RecordBatch) => import('apache-arrow').RecordBatch | null} [options.batchPreprocessor]
	 *   Transforms each batch as it's read; return null to drop the batch
	 * @param {(progress: {rowsRead: number, totalRows?: number}) => void} [options.onProgress]
	 * @param {AbortSignal} [options.signal]
	 * @returns {AsyncGenerator<import('apache-arrow').RecordBatch>}
	 */
	toArrowBatchIterator(...args) {
		const options = parseArgs(args, ['maxResults'], {
			defaults: { maxParallelization: getDefaultParallelization() },
			allowed: iteratorOptions,
		});
		validateReadOptions(options);
		return this.#iterate(options);
	}

	async *#iterate({ maxResults, variables, maxParallelization, batchPreprocessor, onProgress, signal }) {
		const read = await this._prepareRead({ maxResults, variables, maxParallelization, signal });
		yield* readBatches(read, { maxResults, batchPreprocessor, onProgress, signal });
	}

	/**
	 * Reads the rows into an arrow Table. In the browser, reads are limited to 100MB by default (see `maxBytes`).
	 *
	 * @param {number} [maxResults] The maximum number of rows to read
	 * @param {object} [options] The same options as toArrowBatchIterator(), as well as:
	 * @param {number|null} [options.maxBytes] Fail rather than read more than this many bytes into memory. Defaults
	 *   to 100MB in the browser, and no limit in Node; pass null for no limit.
	 * @returns {Promise<import('apache-arrow').Table>}
	 */
	async toArrowTable(...args) {
		const options = parseArgs(args, ['maxResults'], {
			defaults: { maxParallelization: getDefaultParallelization(), maxBytes: getDefaultMaxBytes() },
			allowed: iteratorOptions,
		});
		validateReadOptions(options);
		const { maxResults, variables, maxParallelization, maxBytes, signal } = options;
		const read = await this._prepareRead({ maxResults, variables, maxParallelization, maxBytes, signal });
		return readTable(read, options);
	}

	/**
	 * Reads the rows into an array of plain objects, keyed by variable name. In the browser, reads are limited to 100MB
	 * by default (see `maxBytes`).
	 *
	 * @param {number} [maxResults] The maximum number of rows to read
	 * @param {object} [options] The same options as toArrowTable(), as well as:
	 * @param {boolean} [options.bigInt=false] Return integers as BigInts, rather than Numbers (which lose precision
	 *   beyond 2^53)
	 * @param {boolean} [options.temporal=true] Return dates, dateTimes, and times as Temporal.PlainDate,
	 *   Temporal.PlainDateTime, and Temporal.PlainTime. If false, dates and dateTimes are returned as Dates (in UTC,
	 *   with millisecond precision) and times as strings (HH:MM:SS[.ffffff]).
	 * @returns {Promise<object[]>}
	 */
	async toRowsArray(...args) {
		const { bigInt, temporal, ...options } = parseArgs(args, ['maxResults'], {
			defaults: { bigInt: false, temporal: true },
			allowed: ['maxParallelization', 'maxBytes', ...iteratorOptions],
		});
		return toRowsArray(await this.toArrowTable(options), { bigInt, temporal });
	}

	/**
	 * Creates a read session, split across up to `targetCount` streams that can each be read independently (e.g., by
	 * separate workers) with the same to* methods.
	 *
	 * @param {number} [targetCount] The number of streams to request. The server may return fewer.
	 * @param {object} [options]
	 * @param {string[]} [options.variables] The variables to read, in order. Defaults to all.
	 * @returns {Promise<ReadStream[]>}
	 */
	async toReadStreams(...args) {
		const { targetCount, variables } = parseArgs(args, ['targetCount'], {
			defaults: { targetCount: getDefaultParallelization() },
			allowed: ['variables'],
		});
		if (!Number.isInteger(targetCount) || targetCount < 1) {
			throw new ValueError('targetCount must be a positive integer');
		}
		await this._getReadInfo();
		const mappedVariables = await this.#getMappedVariables(variables);
		const readSession = await makeRequest({
			method: 'POST',
			path: `${this.uri}/readSessions`,
			payload: {
				requestedStreamCount: targetCount,
				format: 'arrow',
				selectedVariables: variables ? mappedVariables.map(({ name }) => name) : undefined,
			},
		});
		return readSession.streams.map(
			(stream) => new ReadStream(stream.id, { parent: this, mappedVariables, properties: stream }),
		);
	}

	// Waits for the instance to be readable, returning what we know about its size:
	//   { numRows, numBytes, canListRows }
	async _getReadInfo() {
		throw new Error('Not implemented');
	}

	// Determines how the rows will be read: the sources to read them from, and the variables they're conformed to
	async _prepareRead({ maxResults, variables, maxParallelization, maxBytes, signal }) {
		const { numRows, numBytes, canListRows } = await this._getReadInfo();
		const mappedVariables = await this.#getMappedVariables(variables, signal);
		const selectedVariables = variables ? mappedVariables.map(({ name }) => name) : undefined;

		// What matters is the size of the read, not of the whole table, so a capped read is sized by the fraction of
		//   rows requested (as the server does)
		let estimatedBytes = numBytes ?? undefined;
		if (estimatedBytes !== undefined && maxResults !== undefined && maxResults !== null && numRows) {
			estimatedBytes *= Math.min(maxResults, numRows) / numRows;
		}
		// With a subset of variables we can't know the size up front, so it's checked as the data arrives instead
		if (maxBytes && !variables && estimatedBytes > maxBytes) {
			throw maxBytesError(maxBytes);
		}

		if (canListRows && estimatedBytes !== undefined && estimatedBytes < LIST_ROWS_MAX_BYTES) {
			const expectedRows =
				numRows === undefined || numRows === null
					? undefined
					: Math.min(numRows, maxResults ?? Number.POSITIVE_INFINITY);
			return {
				sources: [listRowsSource({ uri: this.uri, selectedVariables, maxResults, expectedRows })],
				mappedVariables,
				totalRows: expectedRows,
			};
		}

		const readSession = await makeRequest({
			method: 'POST',
			path: `${this.uri}/readSessions`,
			signal,
			payload: {
				requestedStreamCount: Math.min(MAX_PARALLELIZATION, maxParallelization),
				maxResults: maxResults ?? undefined,
				selectedVariables,
				format: 'arrow',
			},
		});
		return {
			sources: readSession.streams.map(({ id }) => readStreamSource(id)),
			mappedVariables,
			totalRows: readSession.numRows,
		};
	}

	// The variables to read, in the requested order, matched case-insensitively
	async #getMappedVariables(variables, signal) {
		const allVariables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, signal });
		if (!variables) {
			return allVariables;
		}
		if (!Array.isArray(variables) || !variables.length) {
			throw new ValueError('variables must be a non-empty array of variable names');
		}
		const variablesByName = new Map(allVariables.map((variable) => [variable.name.toLowerCase(), variable]));
		return variables.map((name) => {
			const variable = variablesByName.get(String(name).toLowerCase());
			if (!variable) {
				throw new ValueError(`The variable "${name}" was not found`);
			}
			return variable;
		});
	}
}

/**
 * One stream of a read session, as returned by toReadStreams(). It's read with the same to* methods as its parent,
 * though its variables were already chosen when the read session was created.
 */
export class ReadStream extends TabularReader {
	constructor(...args) {
		super();
		const { id, parent, mappedVariables, properties } = parseArgs(args, ['id'], {
			allowed: ['parent', 'mappedVariables', 'properties'],
		});
		this.id = id;
		this.parent = parent;
		this.mappedVariables = mappedVariables;
		this.properties = properties;
		this.uri = `/readStreams/${encodeURIComponent(id)}`;
	}

	toString() {
		return `<ReadStream ${this.id}>`;
	}

	async toReadStreams() {
		throw new ValueError('A read stream is already part of a read session');
	}

	async _getReadInfo() {
		return { numRows: this.properties?.estimatedRows, canListRows: false };
	}

	async _prepareRead({ variables }) {
		if (variables) {
			throw new ValueError(
				"A read stream's variables are chosen when it's created; pass them to toReadStreams() instead",
			);
		}
		return {
			sources: [readStreamSource(this.id)],
			mappedVariables: this.mappedVariables,
			totalRows: this.properties?.estimatedRows,
		};
	}
}

function validateReadOptions({ maxResults, maxParallelization }) {
	if (maxResults !== undefined && maxResults !== null && (!Number.isInteger(maxResults) || maxResults < 0)) {
		throw new ValueError('maxResults must be a non-negative integer');
	}
	if (!Number.isInteger(maxParallelization) || maxParallelization < 1) {
		throw new ValueError('maxParallelization must be a positive integer');
	}
}

function getDefaultMaxBytes() {
	return isNode ? undefined : DEFAULT_BROWSER_MAX_BYTES;
}
