import Base from './Base.js';
import Export from './Export.js';
import { makePaginatedRequest, makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { NotFoundError, ValueError } from '../common/errors.js';
import { getRecentDirectory, listDirectory } from '../common/files.js';
import { isNode, requireNode } from '../common/node.js';
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

/** @typedef {import('apache-arrow').RecordBatch} RecordBatch */
/** @typedef {import('apache-arrow').Table} ArrowTable */
/** @typedef {import('./Directory.js').default} Directory */
/** @typedef {import('./File.js').default} File */

/**
 * @typedef {object} ReadOptions
 * @property {string[]} [variables] The variables to read, in order (matched case-insensitively). Defaults to all.
 * @property {number} [maxParallelization] The number of streams to read in parallel, for large reads (at most 8)
 * @property {(batch: RecordBatch) => RecordBatch | null | Promise<RecordBatch | null>} [batchPreprocessor] Transforms
 *   each batch as it's read; return null to drop the batch
 * @property {(progress: {rowsRead: number, totalRows?: number}) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {ReadOptions & {maxBytes?: number | null}} ReadTableOptions `maxBytes` fails the read rather than read
 *   more than this many bytes into memory. It defaults to 100MB in the browser, and no limit in Node; pass null for
 *   no limit.
 */

/**
 * @typedef {ReadTableOptions & {bigInt?: boolean, temporal?: boolean}} RowsArrayOptions `bigInt` returns integers as
 *   BigInts, rather than Numbers (which lose precision beyond 2^53). `temporal: false` returns dates and dateTimes as
 *   Dates (in UTC, with millisecond precision) and times as strings (`HH:MM:SS[.ffffff]`), rather than Temporal values.
 */

/**
 * @typedef {object} FileListingOptions
 * @property {string} [fileIdVariable] The variable containing file ids, if not `file_id`
 * @property {string} [fileNameVariable] The variable containing file names, if not `file_name`
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} DataDownloadOptions
 * @property {string} [format='csv'] One of `csv`, `parquet`, `jsonl`, `avro`, `dta` (Stata), `sas7bdat` (SAS), or `sav` (SPSS)
 * @property {boolean} [overwrite=false] Replace existing files
 * @property {number} [maxConcurrency=16] The number of files to download at once
 * @property {(progress: {stage: 'exporting' | 'downloading'} & Record<string, number>) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

const iteratorOptions = ['variables', 'batchPreprocessor', 'onProgress', 'signal'];

// Shared row-reading methods of tables, queries, uploads, and read streams. Subclasses implement _getReadInfo().
export default class TabularReader extends Base {
	/**
	 * Streams the rows as arrow RecordBatches, to consume with `for await`. Nothing is read until iteration starts, and
	 * breaking out of the loop stops the read. Batches from parallel streams arrive in no particular order.
	 *
	 * @example
	 * for await (const batch of table.toArrowBatchIterator({ variables: ['name', 'year'] })) {
	 *   console.log(batch.numRows);
	 * }
	 *
	 * @param {[maxResults?: number | null, options?: ReadOptions] | [options?: ReadOptions & {maxResults?: number | null}]} args
	 *   The maximum number of rows to read, and other options
	 * @returns {AsyncGenerator<RecordBatch, void, undefined>}
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
	 * Reads the rows into an arrow Table, which other libraries (e.g. Arquero, DuckDB-Wasm, Observable Plot) can read
	 * directly. In the browser, reads are limited to 100MB by default (see `maxBytes`).
	 *
	 * @param {[maxResults?: number | null, options?: ReadTableOptions] | [options?: ReadTableOptions & {maxResults?: number | null}]} args
	 *   The maximum number of rows to read, and other options
	 * @returns {Promise<ArrowTable>}
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
	 * By default, dates, dateTimes, and times are returned as `Temporal.PlainDate`, `Temporal.PlainDateTime`, and
	 * `Temporal.PlainTime` (using a polyfill where Temporal isn't built in), and integers as Numbers.
	 *
	 * @param {[maxResults?: number | null, options?: RowsArrayOptions] | [options?: RowsArrayOptions & {maxResults?: number | null}]} args
	 *   The maximum number of rows to read, and other options
	 * @returns {Promise<Record<string, any>[]>}
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
	 * separate workers) with the same `to*` methods.
	 *
	 * @param {[targetCount?: number, options?: {variables?: string[]}] | [options?: {targetCount?: number, variables?: string[]}]} args
	 *   The number of streams to request (the server may return fewer), and the variables to read
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

	/**
	 * Lists the files indexed by this table (or query result), as a Directory. The listing is cached, and only downloaded
	 * again if it has changed.
	 *
	 * @param {[options?: FileListingOptions]} args
	 * @returns {Promise<Directory>}
	 */
	async toDirectory(...args) {
		const { fileIdVariable, fileNameVariable, signal } = parseArgs(args, [], {
			allowed: ['fileIdVariable', 'fileNameVariable', 'signal'],
		});
		const source = await this._getFileSource();
		return listDirectory({ ...source, fileIdVariable, fileNameVariable, signal });
	}

	/**
	 * Returns the file at a path within this table's (or query result's) files.
	 *
	 * @param {[path: string] | [options: {path: string}]} args
	 * @returns {Promise<File>}
	 */
	async file(...args) {
		const { path } = parseArgs(args, ['path']);
		const source = await this._getFileSource();
		// A listing from the last 30 seconds is recent enough
		const directory = getRecentDirectory({ ...source, maxAge: 30_000 }) ?? (await listDirectory(source));
		const node = directory.get(path);
		if (!node) {
			throw new NotFoundError({ description: `No file found at path "${path}"` });
		} else if (!node.uri) {
			throw new ValueError(`"${path}" is a directory, not a file`);
		}
		return node;
	}

	/**
	 * Lists every file indexed by this table (or query result).
	 *
	 * @param {[maxResults?: number | null, options?: FileListingOptions] | [options?: FileListingOptions & {maxResults?: number | null}]} args
	 * @returns {Promise<File[]>}
	 */
	async listFiles(...args) {
		const { maxResults, ...options } = parseArgs(args, ['maxResults'], {
			allowed: ['fileIdVariable', 'fileNameVariable', 'signal'],
		});
		const directory = await this.toDirectory(options);
		return directory.list(maxResults, { mode: 'files', recursive: true });
	}

	/**
	 * Exports the data to files, and downloads them (in Node only).
	 *
	 * @param {[path?: string, options?: DataDownloadOptions] | [options?: DataDownloadOptions & {path?: string}]} args
	 *   A file path, if the export is a single file; otherwise (or if it's an existing directory, or ends with a
	 *   separator) the directory to download into. Defaults to the current working directory.
	 * @returns {Promise<string[]>} The paths of the downloaded files
	 */
	async download(...args) {
		const { path, format, ...options } = parseArgs(args, ['path'], {
			defaults: { format: 'csv' },
			allowed: ['overwrite', 'maxConcurrency', 'onProgress', 'signal'],
		});
		requireNode('Downloading files');
		await this._getReadInfo();
		const properties = await makeRequest({
			method: 'POST',
			path: `${this.uri}/exports`,
			payload: { format },
			signal: options.signal,
		});
		const exportJob = new Export(properties.id, { fileName: this._getExportName(), properties });
		return exportJob.downloadFiles(path, options);
	}

	// The table or query that this instance's files belong to
	/**
	 * @protected
	 * @returns {Promise<{table?: import('./Table.js').default, query?: import('./Query.js').default}>}
	 */
	async _getFileSource() {
		throw new ValueError('Listing files is only supported for tables and queries');
	}

	// The name of downloaded export files
	/** @protected */
	_getExportName() {
		return (this.properties?.name || 'export').replace(/\W+/g, '_').toLowerCase();
	}

	// Waits for the instance to be readable, returning what we know about its size
	/**
	 * @protected
	 * @returns {Promise<{numRows?: number, numBytes?: number, canListRows: boolean}>}
	 */
	async _getReadInfo() {
		throw new Error('Not implemented');
	}

	// Determines how the rows will be read: the sources to read them from, and the variables they're conformed to
	/**
	 * @protected
	 * @param {{maxResults?: number | null, variables?: string[], maxParallelization?: number, maxBytes?: number | null, signal?: AbortSignal}} options
	 * @returns {Promise<{sources: object[], mappedVariables: Record<string, any>[], totalRows?: number}>}
	 */
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
	/**
	 * @param {[id: string, options: {parent: TabularReader, mappedVariables: Record<string, any>[], properties?: Record<string, any>}] | [options: {id: string, parent: TabularReader, mappedVariables: Record<string, any>[], properties?: Record<string, any>}]} args
	 */
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

	/**
	 * @returns {Promise<never>}
	 */
	async toReadStreams() {
		throw new ValueError('A read stream is already part of a read session');
	}

	/**
	 * @returns {Promise<never>}
	 */
	async download() {
		throw new ValueError("Read streams can't be downloaded; download their table, query, or upload instead");
	}

	/** @protected */
	async _getReadInfo() {
		return { numRows: this.properties?.estimatedRows, canListRows: false };
	}

	/**
	 * @protected
	 * @param {{variables?: string[]}} options
	 * @returns {Promise<{sources: object[], mappedVariables: Record<string, any>[], totalRows?: number}>}
	 */
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
