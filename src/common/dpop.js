import { isNode } from './node.js';

// DPoP (RFC 9449) binds an access token to a key pair that only this client holds: each request carries a proof, signed
//   by the private key, that covers the request's method and URL, and the API rejects the token without it. In the
//   browser, the private key is non-extractable, so even a script that can read the token (e.g. from sessionStorage)
//   can't take the key elsewhere, and a stolen token is useless on its own. See https://www.rfc-editor.org/rfc/rfc9449.
// It's only used in the browser: in Node, the key would have to be stored alongside the refresh token, which protects
//   nothing that the credentials file's permissions don't already.

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const DB_NAME = 'redivis';
const KEY_STORE = 'dpopKeys';

// By the origin of the API that the key is for, so that each environment has its own key
const keyPromises = new Map();
const supportPromises = new Map();
// How far each API's clock is ahead of ours, in seconds, so that proofs are dated by its clock
const clockOffsets = new Map();
// The API rejects a proof dated more than a minute ahead of its clock, or five minutes behind it, so smaller differences
//   don't need correcting (and the Date header is only accurate to the second)
const CLOCK_SKEW_TOLERANCE_SECONDS = 30;

/**
 * Whether to bind tokens from this API to a DPoP key: in the browser, when the API supports it. Servers that don't
 * would reject the DPoP header, so check their metadata (RFC 9728) first, which is readable from any origin.
 * @param {string} apiOrigin
 * @returns {Promise<boolean>}
 */
export function shouldUseDpop(apiOrigin) {
	if (isNode || !globalThis.crypto?.subtle) {
		return Promise.resolve(false);
	}
	if (!supportPromises.has(apiOrigin)) {
		supportPromises.set(
			apiOrigin,
			fetch(`${apiOrigin}/.well-known/oauth-protected-resource`)
				.then((res) => (res.ok ? res.json() : {}))
				.then((metadata) => !!metadata.dpop_signing_alg_values_supported?.includes('ES256'))
				.catch(() => {
					// Check again next time, e.g. after a network failure
					supportPromises.delete(apiOrigin);
					return false;
				}),
		);
	}
	return supportPromises.get(apiOrigin);
}

/**
 * A DPoP proof for a request, signed by this client's key for the API's origin.
 * @param {{method: string, url: string, accessToken?: string}} options The `accessToken` sent with the request, if any,
 *   which the proof is then bound to
 * @returns {Promise<string>}
 */
export async function createDpopProof({ method, url, accessToken }) {
	const { origin, pathname } = new URL(url);
	const { privateKey, publicJwk } = await getKey(origin);
	const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
	const payload = {
		jti: crypto.randomUUID(),
		htm: method,
		// The URL, without its query or fragment
		htu: `${origin}${pathname}`,
		iat: Math.floor(Date.now() / 1000) + (clockOffsets.get(origin) || 0),
	};
	if (accessToken) {
		payload.ath = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(accessToken)));
	}
	const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
	// WebCrypto's ECDSA signatures are the raw r and s values, which is what JWS expects
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64url(signature)}`;
}

/**
 * Learns the API's clock from the Date header of a response that rejected a DPoP proof, so that later proofs are dated
 * by it: a proof is rejected if our clock is too far off. Only rejections are used, since an error is never served from
 * a cache, where its Date could be out of date.
 *
 * @param {Response} response
 * @param {string} url The URL of the request
 * @returns {boolean} Whether this corrected our clock, in which case a new proof may be accepted
 */
export function syncClockWithServer(response, url) {
	const serverTime = Date.parse(response.headers.get('date'));
	if (isNaN(serverTime)) {
		return false;
	}
	const { origin } = new URL(url);
	const offset = Math.round((serverTime - Date.now()) / 1000);
	if (Math.abs(offset - (clockOffsets.get(origin) || 0)) <= CLOCK_SKEW_TOLERANCE_SECONDS) {
		return false;
	}
	clockOffsets.set(origin, offset);
	return true;
}

/**
 * The thumbprint (RFC 7638) of this client's key for the API's origin, which tokens bound to it carry as `cnf.jkt`.
 * @param {string} apiOrigin
 * @returns {Promise<string>}
 */
export async function getDpopKeyThumbprint(apiOrigin) {
	return (await getKey(apiOrigin)).thumbprint;
}

function getKey(origin) {
	if (!keyPromises.has(origin)) {
		const keyPromise = loadOrCreateKey(origin);
		keyPromises.set(origin, keyPromise);
		keyPromise.catch(() => keyPromises.delete(origin));
	}
	return keyPromises.get(origin);
}

// The key is kept in IndexedDB, so that tokens bound to it (in sessionStorage) survive a reload. A CryptoKey stays
//   non-extractable when stored. Where IndexedDB isn't available (e.g. some private windows), the key only lasts for
//   the page, and tokens bound to an earlier one are discarded (see loadCachedCredentials in auth.js).
async function loadOrCreateKey(origin) {
	const db = await openDatabase().catch(() => null);
	try {
		const storedKey = db && (await idbRequest(db, 'readonly', (store) => store.get(origin)));
		if (storedKey) {
			return storedKey;
		}
		const key = await generateKey();
		if (!db) {
			return key;
		}
		try {
			await idbRequest(db, 'readwrite', (store) => store.add(key, origin));
			return key;
		} catch {
			// Another tab stored a key first, so use that one, which any tokens it obtains are bound to
			return (await idbRequest(db, 'readonly', (store) => store.get(origin))) || key;
		}
	} finally {
		db?.close();
	}
}

async function generateKey() {
	const { privateKey, publicKey } = await crypto.subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);
	const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', publicKey);
	const publicJwk = { kty, crv, x, y };
	// The members are in the lexicographic order that RFC 7638 requires
	const thumbprint = base64url(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv, kty, x, y }))),
	);
	return { privateKey, publicJwk, thumbprint };
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(KEY_STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function idbRequest(db, mode, makeRequest) {
	return new Promise((resolve, reject) => {
		const request = makeRequest(db.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function base64urlJson(value) {
	return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64url(bytes) {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
