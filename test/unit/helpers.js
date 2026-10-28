// Shared setup for the offline tests, which run against a mocked fetch. Import this before the library.
process.env.REDIVIS_API_ENDPOINT = 'https://redivis.test/api/v1';
// A provided token means requests never trigger an interactive login, nor read cached credentials
process.env.REDIVIS_API_TOKEN = 'test-token';

export const API_ROOT = 'https://redivis.test/api/v1';

// Replaces fetch with `handler({ url, path, method, headers, body })`, which returns a Response (or throws, to simulate
//   a network failure). Returns the list of requests made.
export function mockFetch(handler) {
	const requests = [];
	globalThis.fetch = async (url, init = {}) => {
		url = new URL(url);
		const request = {
			url,
			path: url.pathname.replace('/api/v1', ''),
			method: init.method || 'GET',
			headers: init.headers || {},
			signal: init.signal,
			body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
			rawBody: init.body,
		};
		requests.push(request);
		return handler(request);
	};
	return requests;
}

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

// Serializes arrow record batches as an IPC stream body. A `sentinel` adds the empty batch that ends a read stream.
export async function arrowResponse(batches, { sentinel = false, status = 200, headers = {} } = {}) {
	const { RecordBatchStreamWriter } = await import('apache-arrow');
	const writer = new RecordBatchStreamWriter();
	for (const batch of batches) writer.write(batch);
	if (sentinel) writer.write(batches[0].slice(0, 0));
	writer.finish();
	return new Response(writer.toUint8Array(true), {
		status,
		headers: { 'content-type': 'application/vnd.apache.arrow.stream', ...headers },
	});
}
