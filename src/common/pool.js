// Calls `fn(item, index)` for each item, with at most `concurrency` calls in flight, resolving to the results in order.
//   Rejects with the first error, after which no further calls are started.
export async function mapConcurrent(items, concurrency, fn, { signal } = {}) {
	const results = new Array(items.length);
	let nextIndex = 0;
	let failed = false;

	async function worker() {
		while (nextIndex < items.length && !failed) {
			signal?.throwIfAborted();
			const index = nextIndex++;
			try {
				results[index] = await fn(items[index], index);
			} catch (e) {
				failed = true;
				throw e;
			}
		}
	}

	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
	return results;
}
