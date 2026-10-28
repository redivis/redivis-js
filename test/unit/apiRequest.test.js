import { API_ROOT, jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import { makePaginatedRequest, makeRequest } from '../../src/common/apiRequest.js';
import { APIError, AuthorizationError, NetworkError, NotFoundError } from '../../src/common/errors.js';

test('sends authenticated requests with client headers and query parameters', async () => {
	const requests = mockFetch(() => jsonResponse({ ok: true }));
	const res = await makeRequest({ path: '/things', query: { a: 1, list: ['x', 'y'], skip: undefined } });

	assert.deepEqual(res, { ok: true });
	const [{ url, method, headers }] = requests;
	assert.equal(method, 'GET');
	assert.equal(url.href, `${API_ROOT}/things?a=1&list=x&list=y`);
	assert.equal(headers.Authorization, 'Bearer test-token');
	assert.equal(headers['X-Redivis-Client'], 'redivis-js');
	assert.match(headers['User-Agent'], /^redivis-js\//);
});

test('sends payloads as JSON, and returns text responses as text', async () => {
	const requests = mockFetch(() => new Response('OK', { headers: { 'content-type': 'text/plain' } }));
	assert.equal(await makeRequest({ method: 'POST', path: '/things', payload: { a: 1 } }), 'OK');
	assert.deepEqual(requests[0].body, { a: 1 });
	assert.equal(requests[0].headers['Content-Type'], 'application/json');
});

test('returns the raw response when parseResponse is false', async () => {
	mockFetch(() => jsonResponse({ ok: true }));
	const res = await makeRequest({ path: '/things', parseResponse: false });
	assert.ok(res instanceof Response);
});

test('retries a 503', async () => {
	let attempts = 0;
	mockFetch(() => (++attempts === 1 ? jsonResponse({ error: 'unavailable' }, { status: 503 }) : jsonResponse({})));
	await makeRequest({ method: 'POST', path: '/things', payload: {} });
	assert.equal(attempts, 2);
});

test('retries network failures for idempotent requests only', async () => {
	let attempts = 0;
	mockFetch(() => {
		if (++attempts === 1) throw new TypeError('fetch failed');
		return jsonResponse({});
	});
	await makeRequest({ path: '/things' });
	assert.equal(attempts, 2);

	attempts = 0;
	mockFetch(() => {
		attempts++;
		throw new TypeError('fetch failed');
	});
	await assert.rejects(makeRequest({ method: 'POST', path: '/things', payload: {} }), (e) => {
		assert.ok(e instanceof NetworkError);
		assert.equal(e.cause.message, 'fetch failed');
		return true;
	});
	assert.equal(attempts, 1);
});

test('maps error responses to typed errors', async () => {
	mockFetch(() => jsonResponse({ error: 'not_found', error_description: 'No such table' }, { status: 404 }));
	await assert.rejects(makeRequest({ path: '/tables/x' }), (e) => {
		assert.ok(e instanceof NotFoundError);
		assert.ok(e instanceof APIError);
		assert.equal(e.status, 404);
		assert.equal(e.code, 'not_found');
		assert.equal(e.message, 'No such table');
		return true;
	});

	mockFetch(() => jsonResponse({ error: 'forbidden', error_description: 'Nope' }, { status: 403 }));
	await assert.rejects(makeRequest({ path: '/x' }), AuthorizationError);

	mockFetch(() => jsonResponse({ error: { message: 'Bad input' } }, { status: 400 }));
	await assert.rejects(makeRequest({ path: '/x' }), (e) => {
		assert.ok(e instanceof APIError && !(e instanceof NotFoundError));
		assert.equal(e.description, 'Bad input');
		assert.equal(e.message, '[400 api_error] Bad input');
		return true;
	});

	mockFetch(() => new Response('Internal error', { status: 500 }));
	await assert.rejects(makeRequest({ path: '/x' }), { status: 500, description: 'Internal error' });
});

test('reads HEAD errors from the error payload header', async () => {
	const errorPayload = encodeURIComponent(JSON.stringify({ error: 'forbidden', error_description: 'No access' }));
	mockFetch(() => new Response(null, { status: 403, headers: { 'x-redivis-error-payload': errorPayload } }));
	await assert.rejects(makeRequest({ method: 'HEAD', path: '/x' }), { status: 403, description: 'No access' });
});

test('exists() checks with a HEAD request', async () => {
	const requests = mockFetch(({ path }) =>
		path.endsWith('missing') ? new Response(null, { status: 404 }) : new Response(null, { status: 200 }),
	);
	assert.equal(await redivis.dataset('demo.present').exists(), true);
	assert.equal(await redivis.dataset('demo.missing').exists(), false);
	assert.deepEqual(
		requests.map(({ method, path }) => `${method} ${path}`),
		['HEAD /datasets/demo.present', 'HEAD /datasets/demo.missing'],
	);
});

test('prints each API warning once', async (t) => {
	const warn = t.mock.method(console, 'warn', () => {});
	mockFetch(() => jsonResponse({}, { headers: { 'x-redivis-warning': 'This API is deprecated' } }));
	await makeRequest({ path: '/x' });
	await makeRequest({ path: '/x' });
	assert.equal(warn.mock.callCount(), 1);
	assert.equal(warn.mock.calls[0].arguments[0], 'This API is deprecated');
});

test('paginates up to maxResults', async () => {
	const requests = mockFetch(({ url }) => {
		const page = Number(url.searchParams.get('pageToken') || 0);
		const maxResults = Number(url.searchParams.get('maxResults'));
		return jsonResponse({
			results: Array.from({ length: maxResults }, (_, i) => page * 100 + i),
			nextPageToken: page < 5 ? String(page + 1) : undefined,
		});
	});
	const query = { labels: 'a' };
	const results = await makePaginatedRequest({ path: '/things', pageSize: 2, maxResults: 5, query });

	assert.equal(results.length, 5);
	assert.deepEqual(
		requests.map(({ url }) => url.searchParams.get('maxResults')),
		['2', '2', '1'],
	);
	assert.ok(requests.every(({ url }) => url.searchParams.get('labels') === 'a'));
	assert.deepEqual(query, { labels: 'a' });
});

test('currentUser() fetches the authenticated user', async () => {
	mockFetch(({ path }) => {
		assert.equal(path, '/users/me');
		return jsonResponse({ name: 'jane', kind: 'user' });
	});
	const user = await redivis.currentUser();
	assert.equal(user.name, 'jane');
	assert.equal(user.uri, '/users/jane');
	assert.equal(user.getProperty('kind'), 'user');
});
