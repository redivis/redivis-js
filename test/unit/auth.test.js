import { jsonResponse, mockFetch } from './helpers.js';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import redivis from '../../index.js';
import { APIError } from '../../src/common/errors.js';
import { getAuthToken } from '../../src/common/auth.js';

// Credentials are cached in their own directory, rather than the helpers' API token being used
const configDir = await mkdtemp(join(tmpdir(), 'redivis-auth-test-'));
// The helpers' API endpoint is https://redivis.test/api/v1
const credentialsFile = join(configDir, 'environments', 'redivis.test', 'js_credentials');
process.env.REDIVIS_CONFIG_DIR = configDir;
delete process.env.REDIVIS_API_TOKEN;

after(() => rm(configDir, { recursive: true, force: true }));

beforeEach(async () => {
	delete process.env.REDIVIS_API_TOKEN;
	await redivis.deauthorize();
});

const inAnHour = () => Date.now() / 1000 + 3600;

async function cacheCredentials(credentials, file = credentialsFile) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ refresh_token: 'refresh-1', ...credentials }));
}

// Mocks the API, which responds to requests authorized with `validToken`, and the OAuth server, which issues
//   `newToken` for a valid refresh token (and a `newRefreshToken` to replace it, if given, as when rotating)
function mockAuth({ validToken = 'access-2', newToken = 'access-2', newRefreshToken, refreshStatus = 200 } = {}) {
	return mockFetch(({ path, headers, body }) => {
		if (path === '/oauth/token') {
			assert.equal(body.grant_type, 'refresh_token');
			return refreshStatus === 200
				? jsonResponse({
						access_token: newToken,
						refresh_token: newRefreshToken,
						expires_at: inAnHour(),
						expires_in: 3600,
					})
				: jsonResponse({ error: 'invalid_grant' }, { status: refreshStatus });
		} else if (path === '/oauth/device_authorization') {
			// Rather than start an interactive login
			return jsonResponse({ error: 'invalid_client' }, { status: 400 });
		} else if (path === '/public') {
			return jsonResponse({ ok: true });
		}
		return headers.Authorization === `Bearer ${validToken}`
			? jsonResponse({ ok: true })
			: jsonResponse({ error: 'invalid_token' }, { status: 401 });
	});
}

const authorizationHeaders = (requests) =>
	requests.filter(({ path }) => !path.startsWith('/oauth')).map(({ headers }) => headers.Authorization);

test('without credentials, requests are made anonymously', async () => {
	const requests = mockAuth();

	assert.equal(await redivis.isAuthorized(), false);
	await redivis.makeApiRequest({ path: '/public' });

	assert.deepEqual(authorizationHeaders(requests), [undefined]);
});

test('an API token from the environment is sent, and never refreshed', async () => {
	process.env.REDIVIS_API_TOKEN = 'env-token';
	const requests = mockAuth({ validToken: 'env-token' });

	assert.equal(await redivis.isAuthorized(), true);
	await redivis.makeApiRequest({ path: '/private' });
	assert.deepEqual(authorizationHeaders(requests), ['Bearer env-token']);

	// A rejected token can't be fixed by logging in, so the error is thrown
	process.env.REDIVIS_API_TOKEN = 'revoked-token';
	await assert.rejects(redivis.makeApiRequest({ path: '/private' }), (error) => {
		assert.ok(error instanceof APIError);
		assert.equal(error.status, 401);
		return true;
	});
	assert.equal(requests.filter(({ path }) => path.startsWith('/oauth')).length, 0);
});

test('authorize({ apiToken }) holds the token in memory only', async () => {
	const requests = mockAuth({ validToken: 'given-token' });

	await redivis.authorize({ apiToken: 'given-token' });
	await redivis.makeApiRequest({ path: '/private' });

	assert.deepEqual(authorizationHeaders(requests), ['Bearer given-token']);
	await assert.rejects(stat(credentialsFile), { code: 'ENOENT' });

	await redivis.deauthorize();
	assert.equal(await redivis.isAuthorized(), false);
});

test('cached credentials are read from REDIVIS_CONFIG_DIR', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	const requests = mockAuth({ validToken: 'access-1' });

	assert.equal(await redivis.isAuthorized(), true);
	await redivis.makeApiRequest({ path: '/private' });

	assert.deepEqual(authorizationHeaders(requests), ['Bearer access-1']);
});

test('an access token that is about to expire is refreshed first, once', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: Date.now() / 1000 + 60 });
	const requests = mockAuth({ newToken: 'access-2' });

	await Promise.all([redivis.makeApiRequest({ path: '/a' }), redivis.makeApiRequest({ path: '/b' })]);

	assert.deepEqual(authorizationHeaders(requests), ['Bearer access-2', 'Bearer access-2']);
	assert.equal(requests.filter(({ path }) => path === '/oauth/token').length, 1);
	// The refreshed token is saved, with the refresh token, readable only by this user
	const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
	assert.equal(saved.access_token, 'access-2');
	assert.equal(saved.refresh_token, 'refresh-1');
	// Windows has no POSIX permission bits (files there are protected by ACLs, which Node doesn't report)
	if (process.platform !== 'win32') {
		assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
	}
});

test('a rotated refresh token replaces the one that was used', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: Date.now() / 1000 + 60 });
	const requests = mockAuth({ newToken: 'access-2', newRefreshToken: 'refresh-2' });

	await redivis.makeApiRequest({ path: '/private' });

	const refreshes = requests.filter(({ path }) => path === '/oauth/token');
	assert.deepEqual(
		refreshes.map(({ body }) => body.refresh_token),
		['refresh-1'],
	);
	const saved = JSON.parse(await readFile(credentialsFile, 'utf8'));
	assert.equal(saved.access_token, 'access-2');
	assert.equal(saved.refresh_token, 'refresh-2');
});

test('credentials that another process refreshed are used, rather than the replaced refresh token', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	mockAuth({ validToken: 'access-1' });
	await redivis.makeApiRequest({ path: '/private' });

	// Another process refreshes the shared credentials, which replaces the refresh token held here
	await cacheCredentials({ access_token: 'access-2', refresh_token: 'refresh-2', expires_at: inAnHour() });
	const requests = mockAuth({ validToken: 'access-2' });
	await redivis.makeApiRequest({ path: '/private' });

	assert.deepEqual(authorizationHeaders(requests), ['Bearer access-1', 'Bearer access-2']);
	assert.equal(requests.filter(({ path }) => path === '/oauth/token').length, 0);
});

test('a rejected access token is refreshed, and the request retried', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	const requests = mockAuth({ validToken: 'access-2', newToken: 'access-2' });

	assert.deepEqual(await redivis.makeApiRequest({ path: '/private' }), { ok: true });

	assert.deepEqual(
		requests.map(({ path }) => path),
		['/private', '/oauth/token', '/private'],
	);
	assert.deepEqual(authorizationHeaders(requests), ['Bearer access-1', 'Bearer access-2']);
});

test('a rejected refresh token clears the credentials, and requires a login', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: Date.now() / 1000 + 60 });
	const requests = mockAuth({ refreshStatus: 400 });

	// The (mocked) login fails, rather than prompting
	await assert.rejects(redivis.makeApiRequest({ path: '/private' }), { message: 'invalid_client', status: 400 });

	assert.ok(requests.some(({ path }) => path === '/oauth/device_authorization'));
	await assert.rejects(stat(credentialsFile), { code: 'ENOENT' });
	assert.equal(await redivis.isAuthorized(), false);
});

test('a login that the API asks for is requested with the current token, so that the user is asked to use it', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	const requests = mockFetch(({ path }) =>
		path === '/oauth/device_authorization'
			? jsonResponse({ error: 'invalid_client' }, { status: 400 })
			: jsonResponse({ error: 'insufficient_user_authentication', amr_values: '123 456' }, { status: 401 }),
	);

	await assert.rejects(redivis.makeApiRequest({ path: '/private' }), { message: 'invalid_client', status: 400 });

	const deviceAuthorization = requests.find(({ path }) => path === '/oauth/device_authorization');
	assert.equal(deviceAuthorization.body.amr_values, '123 456');
	assert.equal(deviceAuthorization.headers.Authorization, 'Bearer access-1');
});

test('a rejected refresh token falls back to an anonymous request, without a login', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: Date.now() / 1000 + 60 });
	const requests = mockAuth({ refreshStatus: 400 });

	assert.deepEqual(await redivis.makeApiRequest({ path: '/public' }), { ok: true });

	assert.deepEqual(
		requests.map(({ path }) => path),
		['/oauth/token', '/public'],
	);
	assert.deepEqual(authorizationHeaders(requests), [undefined]);
	assert.equal(await redivis.isAuthorized(), false);
});

test('a token without the default scope is sent as is, rather than prompting a login first', async () => {
	const payload = btoa(JSON.stringify({ scope: 'data.data' })).replace(/=+$/, '');
	const accessToken = `header.${payload}.signature`;
	await cacheCredentials({ access_token: accessToken, expires_at: inAnHour() });
	const requests = mockAuth();

	assert.deepEqual(await redivis.makeApiRequest({ path: '/public' }), { ok: true });

	assert.deepEqual(authorizationHeaders(requests), [`Bearer ${accessToken}`]);
	assert.equal(requests.filter(({ path }) => path.startsWith('/oauth')).length, 0);
});

test('a failed refresh for another reason keeps the credentials', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: Date.now() / 1000 + 60 });
	mockAuth({ refreshStatus: 500 });

	await assert.rejects(redivis.makeApiRequest({ path: '/private' }), { status: 500 });

	assert.equal(JSON.parse(await readFile(credentialsFile, 'utf8')).refresh_token, 'refresh-1');
});

test('deauthorize() deletes the cached credentials', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	assert.equal(await redivis.isAuthorized(), true);

	await redivis.deauthorize();

	assert.equal(await redivis.isAuthorized(), false);
	await assert.rejects(stat(credentialsFile), { code: 'ENOENT' });
});

test('each API endpoint has its own credentials', async () => {
	await cacheCredentials({ access_token: 'access-1', expires_at: inAnHour() });
	assert.equal(await redivis.isAuthorized(), true);

	try {
		redivis.config({ apiEndpoint: 'http://localhost:8080/api/v1' });
		assert.equal(await redivis.isAuthorized(), false);
		await cacheCredentials(
			{ access_token: 'access-local', expires_at: inAnHour() },
			join(configDir, 'environments', 'localhost_8080', 'js_credentials'),
		);
		assert.equal(await getAuthToken(), 'access-local');
	} finally {
		redivis.config({ apiEndpoint: null });
	}
	assert.equal(await getAuthToken(), 'access-1');
});

test("redivis.com's credentials are kept directly in the config directory", async () => {
	try {
		redivis.config({ apiEndpoint: 'https://redivis.com/api/v1' });
		await cacheCredentials(
			{ access_token: 'access-redivis', expires_at: inAnHour() },
			join(configDir, 'js_credentials'),
		);
		assert.equal(await getAuthToken(), 'access-redivis');

		await redivis.deauthorize();
		await assert.rejects(stat(join(configDir, 'js_credentials')), { code: 'ENOENT' });
	} finally {
		redivis.config({ apiEndpoint: null });
	}
});

// Last, since a proxy can't be unset
test('requests through an API proxy carry its headers, and never log in', async () => {
	const requests = mockFetch(() => jsonResponse({ error: 'invalid_token' }, { status: 401 }));
	assert.throws(() => redivis.setApiProxy({}), /baseUrl/);

	redivis.setApiProxy('https://proxy.test/redivis', { headers: { 'X-Proxy-Key': 'k' } });
	await assert.rejects(redivis.makeApiRequest({ path: '/private' }), { status: 401 });

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url.href, 'https://proxy.test/redivis/private');
	assert.equal(requests[0].headers['X-Proxy-Key'], 'k');
	assert.equal(requests[0].headers.Authorization, undefined);
});
