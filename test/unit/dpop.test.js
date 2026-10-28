import { jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRequest } from '../../src/common/apiRequest.js';
import { addDpopProof } from '../../src/common/auth.js';
import { createDpopProof, getDpopKeyThumbprint, shouldUseDpop, syncClockWithServer } from '../../src/common/dpop.js';

const API = 'https://redivis.test';

function decode(proof) {
	const [header, payload, signature] = proof.split('.');
	return {
		header: JSON.parse(Buffer.from(header, 'base64url')),
		payload: JSON.parse(Buffer.from(payload, 'base64url')),
		signingInput: `${header}.${payload}`,
		signature: Buffer.from(signature, 'base64url'),
	};
}

async function sha256(text) {
	return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64url');
}

test('a proof covers the request, and is signed by the public key it carries', async () => {
	const before = Math.floor(Date.now() / 1000);
	const proof = await createDpopProof({ method: 'GET', url: `${API}/api/v1/users/me?a=1#b` });
	const { header, payload, signingInput, signature } = decode(proof);

	assert.equal(header.typ, 'dpop+jwt');
	assert.equal(header.alg, 'ES256');
	assert.deepEqual(Object.keys(header.jwk).sort(), ['crv', 'kty', 'x', 'y']);
	assert.equal(payload.htm, 'GET');
	// Without the query or fragment
	assert.equal(payload.htu, `${API}/api/v1/users/me`);
	assert.ok(payload.iat >= before && payload.iat <= Math.floor(Date.now() / 1000));
	assert.equal(payload.ath, undefined);

	const publicKey = await crypto.subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
		'verify',
	]);
	assert.ok(
		await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature,
			new TextEncoder().encode(signingInput),
		),
	);
});

test('a proof sent with an access token is bound to it', async () => {
	const { payload } = decode(await createDpopProof({ method: 'POST', url: `${API}/api/v1/x`, accessToken: 'tok' }));
	assert.equal(payload.ath, await sha256('tok'));
});

test('each proof is unique, and signed by the same key for an API', async () => {
	const first = decode(await createDpopProof({ method: 'GET', url: `${API}/a` }));
	const second = decode(await createDpopProof({ method: 'GET', url: `${API}/b` }));
	assert.notEqual(first.payload.jti, second.payload.jti);
	assert.deepEqual(first.header.jwk, second.header.jwk);

	// The thumbprint is of the key's required members, in lexicographic order (RFC 7638)
	const { crv, kty, x, y } = first.header.jwk;
	assert.equal(await getDpopKeyThumbprint(API), await sha256(JSON.stringify({ crv, kty, x, y })));
});

test('each API has its own key', async () => {
	const other = decode(await createDpopProof({ method: 'GET', url: 'https://other.test/a' }));
	const first = decode(await createDpopProof({ method: 'GET', url: `${API}/a` }));
	assert.notDeepEqual(other.header.jwk, first.header.jwk);
	assert.notEqual(await getDpopKeyThumbprint('https://other.test'), await getDpopKeyThumbprint(API));
});

test('only requests with a DPoP-bound token get a proof', async () => {
	const bearer = { Authorization: 'Bearer tok' };
	await addDpopProof(bearer, { method: 'GET', url: `${API}/a` });
	assert.equal(bearer.DPoP, undefined);

	const bound = { Authorization: 'DPoP tok' };
	await addDpopProof(bound, { method: 'GET', url: `${API}/a` });
	assert.equal(decode(bound.DPoP).payload.ath, await sha256('tok'));
});

test("Node doesn't bind tokens, since its key would be stored with the refresh token", async () => {
	assert.equal(await shouldUseDpop(API), false);
});

const now = () => Math.floor(Date.now() / 1000);
// A response dated by a server whose clock is `offset` seconds ahead of ours
const responseDated = (offset, init) =>
	jsonResponse(
		{ error: 'invalid_dpop_proof' },
		{ status: 401, headers: { date: new Date(Date.now() + offset * 1000).toUTCString() }, ...init },
	);
const iatOf = async (url) => decode(await createDpopProof({ method: 'GET', url })).payload.iat;

test("proofs are dated by the server's clock, once a rejection shows ours is off", async () => {
	const url = 'https://clock.test/api/v1/x';
	assert.equal(syncClockWithServer(responseDated(600), url), true);
	assert.ok(Math.abs((await iatOf(url)) - (now() + 600)) <= 2);
	// Other APIs keep their own clocks
	assert.ok(Math.abs((await iatOf('https://other.test/x')) - now()) <= 1);

	// Small differences, and responses without a Date, don't change it
	assert.equal(syncClockWithServer(responseDated(610), url), false);
	assert.equal(syncClockWithServer(new Response(null, { status: 401 }), url), false);
	assert.ok(Math.abs((await iatOf(url)) - (now() + 600)) <= 2);

	// And it follows the server's clock back
	assert.equal(syncClockWithServer(responseDated(0), url), true);
	assert.ok(Math.abs((await iatOf(url)) - now()) <= 2);
});

test('a request whose proof is rejected for our clock is retried once, with a proof dated by the server', async () => {
	let attempt = 0;
	const requests = mockFetch(() => (++attempt === 1 ? responseDated(-900) : jsonResponse({ ok: true })));

	assert.deepEqual(await makeRequest({ path: '/x', headers: { Authorization: 'DPoP tok' } }), { ok: true });
	assert.equal(requests.length, 2);
	const [first, second] = requests.map(({ headers }) => decode(headers.DPoP).payload);
	assert.notEqual(first.jti, second.jti);
	assert.ok(Math.abs(second.iat - (now() - 900)) <= 2);
});

test("a rejected proof isn't retried when our clock agrees with the server's", async () => {
	// Already in sync with this server, from the test above
	const requests = mockFetch(() => responseDated(-900));
	await assert.rejects(makeRequest({ path: '/x', headers: { Authorization: 'DPoP tok' } }), { status: 401 });
	assert.equal(requests.length, 1);
});
