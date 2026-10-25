import { RecordBatch, RecordBatchReader, Struct, Table, makeData } from 'apache-arrow';
import { makeRequest, sleep } from './apiRequest.js';
import { coerceVector, makeNullData, typesEqual, variablesToSchema } from './arrowTypes.js';
import { APIError, NetworkError, ValueError } from './errors.js';
import { isNode } from './node.js';

// Read sessions are parallelized across at most this many streams
export const MAX_PARALLELIZATION = 8;
// Reads (estimated to be) smaller than this use a single listRows request, rather than a read session
export const LIST_ROWS_MAX_BYTES = 1e8;
// In-memory reads in the browser are capped at this size by default
export const DEFAULT_BROWSER_MAX_BYTES = 1e8;

const MAX_RETRIES = 10;

export function getDefaultParallelization() {
	return Math.min(MAX_PARALLELIZATION, globalThis.navigator?.hardwareConcurrency || 4);
}

// A stream that can be resumed from a row offset, and terminates with an empty end-of-stream sentinel batch
export function readStreamSource(id) {
	return { path: `/readStreams/${encodeURIComponent(id)}`, query: {}, resumable: true };
}

// A single listRows request, which can be read anonymously for public tables. It can't be resumed, so an interrupted
//   read restarts, and completion is verified by the number of rows received.
export function listRowsSource({ uri, selectedVariables, maxResults, expectedRows }) {
	return {
		path: `${uri}/rows`,
		// NB: parameters are in a fixed order, so the URL is stable and the browser can revalidate its cached response
		query: { selectedVariables: selectedVariables?.join(','), maxResults, format: 'arrow' },
		resumable: false,
		expectedRows,
		// The API respects If-Modified-Since, so let the browser revalidate (rather than re-download) a repeated read
		cache: isNode ? undefined : 'no-cache',
	};
}

/**
 * Reads the record batches of the given sources, conformed to the mapped variables' schema.
 *
 * @param {object} read
 * @param {object[]} read.sources
 * @param {object[]} read.mappedVariables The variables to read, in order
 * @param {number} [read.totalRows] The expected number of rows, for progress
 * @param {object} options
 * @param {number} [options.maxResults]
 * @param {Function} [options.batchPreprocessor] Called with each RecordBatch; returns a RecordBatch, or null to drop it
 * @param {Function} [options.onProgress] Called with `{ rowsRead, totalRows }` as batches are read
 * @param {number} [options.maxBytes] Fail once more than this many bytes have been received
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.withSourceIndex] Yield `{ batch, sourceIndex }` rather than the batch
 * @returns {AsyncGenerator<RecordBatch>}
 */
export async function* readBatches(
	{ sources, mappedVariables, totalRows },
	{ maxResults, batchPreprocessor, onProgress, maxBytes, signal, withSourceIndex = false } = {},
) {
	const controller = new AbortController();
	const abort = () => controller.abort(signal.reason);
	signal?.addEventListener('abort', abort, { once: true });
	if (signal?.aborted) abort();

	const context = {
		signal: controller.signal,
		outputSchema: variablesToSchema(mappedVariables),
		bytesRead: 0,
		maxBytes,
		rowsRead: 0,
		onRows(count) {
			this.rowsRead += count;
			onProgress?.({ rowsRead: this.rowsRead, totalRows });
		},
	};

	let rowsYielded = 0;
	try {
		const merged = mergeAsyncIterators(
			sources.map((source) => readSource(source, context)),
			// Stops any streams still being read before they're closed, so that closing them doesn't wait on the network
			() => controller.abort(),
		);
		for await (const { value, index } of merged) {
			let batch = conformBatch(value, context.outputSchema);
			if (maxResults !== undefined && maxResults !== null) {
				if (rowsYielded >= maxResults) break;
				if (rowsYielded + batch.numRows > maxResults) {
					batch = batch.slice(0, maxResults - rowsYielded);
				}
			}
			rowsYielded += batch.numRows;

			if (batchPreprocessor) {
				batch = await batchPreprocessor(batch);
				if (!batch) continue;
			}
			yield withSourceIndex ? { batch, sourceIndex: index } : batch;
		}
	} finally {
		signal?.removeEventListener('abort', abort);
		controller.abort();
	}
}

/**
 * Reads the sources into a single arrow Table. Batches are kept in source order.
 * @returns {Promise<Table>}
 */
export async function readTable(read, options = {}) {
	for (let attempt = 0; ; attempt++) {
		const batchesBySource = read.sources.map(() => []);
		try {
			for await (const { batch, sourceIndex } of readBatches(read, { ...options, withSourceIndex: true })) {
				batchesBySource[sourceIndex].push(batch);
			}
		} catch (e) {
			// A listRows request that's interrupted can't be resumed, but reading into memory, we can start over
			if (e.restartable && attempt < MAX_RETRIES) {
				await sleep(attempt * 1000, options.signal);
				continue;
			}
			throw e;
		}

		const batches = batchesBySource.flat();
		if (!batches.length) {
			return new Table(variablesToSchema(read.mappedVariables));
		}
		return new Table(batches);
	}
}

async function* readSource(source, context) {
	let offset = 0;
	let retryCount = 0;
	let hasYielded = false;

	while (true) {
		let receivedSentinel = false;
		try {
			const response = await makeRequest({
				method: 'GET',
				path: source.path,
				query: source.resumable ? { ...source.query, offset, eosSentinel: true } : source.query,
				parseResponse: false,
				cache: source.cache,
				signal: context.signal,
			});
			const reader = await RecordBatchReader.from(countBytes(response.body, context));
			for await (const batch of reader) {
				// The server ends a resumable stream with an empty batch, confirming that it wasn't cut off
				if (batch.numRows === 0) {
					receivedSentinel = true;
					break;
				}
				offset += batch.numRows;
				retryCount = 0;
				hasYielded = true;
				context.onRows(batch.numRows);
				yield batch;
			}

			// NB: arrow-js ends the read, rather than throwing, when the body stream errors (or is aborted)
			if (context.exceededMaxBytes) {
				throw maxBytesError(context.maxBytes);
			}
			context.signal.throwIfAborted();

			const isFinished = source.resumable
				? receivedSentinel
				: source.expectedRows === undefined || offset >= source.expectedRows;
			if (isFinished) {
				return;
			}
			throw new NetworkError('The stream ended before all rows were received');
		} catch (e) {
			if (context.exceededMaxBytes) {
				throw maxBytesError(context.maxBytes);
			}
			context.signal.throwIfAborted();
			// Errors that retrying can't fix. makeRequest has already retried any failure to connect.
			if (e instanceof APIError || e instanceof ValueError || (e instanceof NetworkError && e.cause)) {
				throw e;
			}
			if (!source.resumable && hasYielded) {
				// Rows were already handed out, and the stream can't be resumed (nor its order relied upon), so the read
				//   can only start over from scratch
				context.onRows(-offset);
				const error = new NetworkError('The connection was interrupted', { cause: e });
				error.restartable = true;
				throw error;
			}
			if (retryCount >= MAX_RETRIES) {
				throw new NetworkError(`Reading rows failed after ${retryCount} retries`, { cause: e });
			}
			retryCount++;
			await sleep(retryCount * 1000, context.signal);
			if (!source.resumable) {
				context.onRows(-offset);
				offset = 0;
			}
		}
	}
}

// Conforms a batch to the output schema: matching columns case-insensitively, putting them in order, converting any
//   whose type differs, and adding any that are missing as nulls
function conformBatch(batch, outputSchema) {
	if (batch.schema.fields.length === outputSchema.fields.length) {
		const matches = outputSchema.fields.every((field, i) => {
			const batchField = batch.schema.fields[i];
			return batchField.name === field.name && typesEqual(batchField.type, field.type);
		});
		if (matches) {
			return batch;
		}
	}

	const columnIndexes = new Map(batch.schema.fields.map(({ name }, i) => [name.toLowerCase(), i]));
	const children = outputSchema.fields.map((field) => {
		const index = columnIndexes.get(field.name.toLowerCase());
		if (index === undefined) {
			return makeNullData(field.type, batch.numRows);
		}
		const column = batch.getChildAt(index);
		return typesEqual(column.type, field.type) ? column.data[0] : coerceVector(column, field.type, field.name);
	});

	return new RecordBatch(
		outputSchema,
		makeData({ type: new Struct(outputSchema.fields), length: batch.numRows, nullCount: 0, children }),
	);
}

// Counts the bytes of a response body as it's read, failing the read once it exceeds the context's maxBytes
function countBytes(body, context) {
	return body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				context.bytesRead += chunk.byteLength;
				if (context.maxBytes && context.bytesRead > context.maxBytes) {
					context.exceededMaxBytes = true;
					controller.error(maxBytesError(context.maxBytes));
				} else {
					controller.enqueue(chunk);
				}
			},
		}),
	);
}

export function maxBytesError(maxBytes) {
	return new ValueError(
		`This read exceeds the limit of ${formatBytes(maxBytes)} for reading data into memory (maxBytes, which in the ` +
			`browser defaults to ${formatBytes(DEFAULT_BROWSER_MAX_BYTES)}). Limit the rows (maxResults) or variables ` +
			`that are read, stream the data with toArrowBatchIterator(), or raise the maxBytes option.`,
	);
}

function formatBytes(bytes) {
	for (const [size, unit] of [
		[1e9, 'GB'],
		[1e6, 'MB'],
		[1e3, 'kB'],
	]) {
		if (bytes >= size) return `${Math.round((bytes / size) * 10) / 10}${unit}`;
	}
	return `${bytes} bytes`;
}

// Yields `{ value, index }` from several async iterators as values become available, rather than in order. `onExit` is
//   called before the iterators are closed, whether they finished or not.
async function* mergeAsyncIterators(iterators, onExit) {
	const next = (index) => iterators[index].next().then((result) => ({ result, index }));
	const pending = new Map(iterators.map((_, index) => [index, next(index)]));
	try {
		while (pending.size) {
			const { result, index } = await Promise.race(pending.values());
			if (result.done) {
				pending.delete(index);
			} else {
				pending.set(index, next(index));
				yield { value: result.value, index };
			}
		}
	} finally {
		onExit();
		// Reads that were still in flight now fail, which nobody needs to hear about
		for (const promise of pending.values()) promise.catch(() => {});
		await Promise.allSettled(iterators.map((iterator) => iterator.return()));
	}
}
