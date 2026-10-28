import { showSignInPrompt } from './signInPrompt.js';
import { isNode, getEnv, importNodeModule } from './node.js';
import { getConfigValue } from './config.js';
import { createDpopProof, getDpopKeyThumbprint, shouldUseDpop, syncClockWithServer } from './dpop.js';

// Node mirrors the Python client: an offline (refresh token) login via the device flow, cached on disk. In the
//   browser the library can run on any site, so it only ever holds a short-lived, read-only token for the tab.
const defaultScope = isNode ? ['data.edit', 'organization.write', 'workflow.write'] : ['data.data'];
// Only used in Node; the browser authenticates as an anonymous client, since it can't hold a refresh token
const clientId = 'qa8FgIMREDy6gkNkGnoOvjDZ';
const browserStorageKey = 'redivis_oauth_token';

// undefined until first loaded; null when there are no cached credentials
let cachedCredentials;
// The file that cachedCredentials were loaded from (in Node), which changes when config({configDir}) does
let cachedCredentialsFile;
// Incremented whenever the credentials are written or cleared
let credentialsGeneration = 0;
let apiToken;
let apiProxy;
let authLock = Promise.resolve();
let popupWindowReference;

function getApiEndpoint() {
	return getConfigValue('apiEndpoint');
}

// Note that https is optional, since traffic can happen over http if all in the same cluster
function getBaseUrl() {
	return getApiEndpoint().match(/^(https?:\/\/.*?)(\/|$)/)[1];
}

/**
 * Authenticates with Redivis. In Node, this logs in through the browser (with the device flow) and caches the
 * credentials on disk; in the browser, it opens a sign-in popup. Requests also authenticate automatically when a
 * resource requires it, so calling this is optional.
 *
 * @param {object} [options]
 * @param {string} [options.apiToken] An API token to use instead of logging in. It's held in memory only.
 * @param {string | string[]} [options.scope] The OAuth scope(s) to request
 * @param {boolean} [options.forceReauthorization=false] Log in again, even if there are cached credentials
 * @returns {Promise<void>}
 */
export async function authorize({ apiToken: apiTokenArg, scope, forceReauthorization = false } = {}) {
	if (apiTokenArg) {
		// Held in memory only; an explicitly provided token is never written to the credentials cache
		apiToken = apiTokenArg;
		return;
	}
	if (forceReauthorization) {
		await withAuthLock(clearCachedCredentials);
	}
	if (typeof scope === 'string') {
		scope = [scope];
	}
	await getAuthToken({ scope });
}

/**
 * Clears any credentials, including those cached on disk (in Node).
 * @returns {Promise<void>}
 */
export async function deauthorize() {
	apiToken = null;
	await withAuthLock(clearCachedCredentials);
}

/**
 * Whether credentials are available, without logging in.
 * @returns {Promise<boolean>}
 */
export async function isAuthorized() {
	return hasCredentials();
}

/**
 * Sends all API requests through a proxy (e.g., your own server, which adds credentials), rather than to Redivis
 * directly. Requests through a proxy never prompt a login.
 *
 * @param {string | {baseUrl: string, headers?: Record<string, string>}} baseUrlArg The proxy's base URL, which replaces
 *   `https://redivis.com/api/v1`; or an object with the base URL and headers to send with every request
 * @param {{headers?: Record<string, string>}} [options]
 * @returns {void}
 */
export function setApiProxy(baseUrlArg, options = {}) {
	if (baseUrlArg && typeof baseUrlArg !== 'object') {
		options.baseUrl = baseUrlArg;
	} else {
		options = baseUrlArg;
	}
	if (!options.baseUrl) {
		throw new Error(`A baseUrl must be provided for the API proxy`);
	}
	apiProxy = options;
}

export async function getRequestConfig() {
	if (apiProxy) {
		// Copy the headers, since the caller adds to them
		return { ...apiProxy, headers: { ...apiProxy.headers } };
	}
	const headers = {};
	// Only obtain a token if we already have credentials on hand; otherwise send the request anonymously, since the
	//   resource may be publicly accessible. If it isn't, makeRequest() authenticates and retries.
	if (await hasCredentials()) {
		headers.Authorization = getAuthorizationHeader(await getAuthToken());
	}
	return { baseUrl: getApiEndpoint(), headers };
}

/**
 * Adds the DPoP proof that a request with a DPoP-bound access token needs (see dpop.js). Each proof is accepted only
 * once, so this is called for every attempt at a request.
 *
 * @param {Record<string, string>} headers The request's headers, including its Authorization
 * @param {{method: string, url: string}} request
 * @returns {Promise<void>}
 */
export async function addDpopProof(headers, { method, url }) {
	const [scheme, accessToken] = headers.Authorization?.split(' ') || [];
	if (scheme === 'DPoP') {
		headers.DPoP = await createDpopProof({ method, url, accessToken });
	}
}

// Tokens bound to a DPoP key are sent with the DPoP scheme, and any other as a bearer token
function getAuthorizationHeader(accessToken) {
	const isDpopBound = accessToken === cachedCredentials?.access_token && cachedCredentials.token_type === 'DPoP';
	return `${isDpopBound ? 'DPoP' : 'Bearer'} ${accessToken}`;
}

// Whether a failed request should prompt a login. Never when the token was provided to us, since logging in
//   wouldn't change what's sent.
export function canReauthorize() {
	return !apiProxy && !apiToken && !getEnv('REDIVIS_API_TOKEN') && !getEnv('REDIVIS_DEFAULT_NOTEBOOK');
}

// Whether an auth token can be obtained without an interactive login
async function hasCredentials() {
	if (apiToken || getEnv('REDIVIS_API_TOKEN')) {
		return true;
	}
	return !!(await loadCachedCredentials());
}

/**
 * @param {{scope?: string[]}} [options]
 * @returns {Promise<string>}
 */
export async function getAuthToken({ scope } = {}) {
	if (apiToken) {
		return apiToken;
	}
	if (getEnv('REDIVIS_API_TOKEN')) {
		return getEnv('REDIVIS_API_TOKEN');
	}
	scope = scope || defaultScope;

	const accessToken = getUnexpiredAccessToken(await loadCachedCredentials(), scope);
	if (accessToken) {
		return accessToken;
	}

	// Only one login or refresh at a time, so that concurrent requests don't each prompt the user
	return withAuthLock(async () => {
		const credentials = await loadCachedCredentials();
		const missingScope = scope.filter((s) => !getCredentialScope(credentials).includes(s));

		if (credentials?.access_token && credentials.expires_at && !missingScope.length) {
			const accessToken = getUnexpiredAccessToken(credentials, scope);
			if (accessToken) {
				// Another caller refreshed the token while this one waited
				return accessToken;
			}
			await refreshCachedCredentials();
			if (cachedCredentials) {
				return cachedCredentials.access_token;
			}
		}
		await performOAuthLogin({
			scope: missingScope.length ? missingScope : scope,
			upgradeCredentials: !!cachedCredentials && !!missingScope.length,
		});
		return cachedCredentials.access_token;
	});
}

// Called after a request was rejected for its credentials (or lack thereof)
/**
 * @param {{scope?: string[], amrValues?: string, rejectedToken?: string}} [options]
 * @returns {Promise<void>}
 */
export async function refreshCredentials({ scope, amrValues, rejectedToken } = {}) {
	await withAuthLock(async () => {
		const credentials = await loadCachedCredentials();
		const payload = decodeAccessToken(credentials);

		// Another request may have already re-authenticated while this one waited
		if (
			credentials &&
			credentials.access_token !== rejectedToken &&
			(!scope || scope.every((s) => getCredentialScope(credentials).includes(s))) &&
			(!amrValues || amrValues.split(' ').every((v) => payload?.amr?.map(String).includes(v)))
		) {
			return;
		}

		if (scope || amrValues) {
			await performOAuthLogin({
				scope: scope || getCredentialScope(credentials),
				amrValues,
				upgradeCredentials: true,
			});
		} else if (!credentials) {
			// The request was made anonymously because no credentials were available. The resource isn't public, so we
			//   need to authenticate now.
			await performOAuthLogin({ scope: defaultScope });
		} else {
			await refreshCachedCredentials();
		}
	});
	await getAuthToken();
}

function withAuthLock(fn) {
	const result = authLock.then(fn);
	authLock = result.catch(() => {});
	return result;
}

function getUnexpiredAccessToken(credentials, scope) {
	// Refresh a token that expires in the next 5 minutes, rather than sending one the server is about to reject
	if (
		credentials?.access_token &&
		credentials.expires_at > Date.now() / 1000 + 5 * 60 &&
		scope.every((s) => getCredentialScope(credentials).includes(s))
	) {
		return credentials.access_token;
	}
	return null;
}

function decodeAccessToken(credentials) {
	try {
		// JWT segments are unpadded base64url
		const base64Payload = credentials.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		return JSON.parse(atob(base64Payload + '='.repeat(-base64Payload.length & 3)));
	} catch (e) {
		return null;
	}
}

function getCredentialScope(credentials) {
	return decodeAccessToken(credentials)?.scope?.split(' ') || defaultScope;
}

// Exchanges the refresh token for a new access token, clearing the credentials if it's been rejected
async function refreshCachedCredentials() {
	if (!cachedCredentials?.refresh_token) {
		return clearCachedCredentials();
	}
	const res = await fetch(`${getBaseUrl()}/oauth/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: clientId,
			grant_type: 'refresh_token',
			refresh_token: cachedCredentials.refresh_token,
		}),
	});
	if (res.status === 400 || res.status === 401) {
		// The refresh token was rejected (e.g. revoked or expired), so the user needs to log in again
		return clearCachedCredentials();
	}
	// Anything else (e.g. a 503 during a deploy) says nothing about the refresh token, so keep it for a later call to
	//   retry with
	const { access_token, token_type, expires_at, expires_in } = await parseOAuthResponse(res);
	await writeCachedCredentials({ ...cachedCredentials, access_token, token_type, expires_at, expires_in });
}

async function performOAuthLogin({ scope, amrValues, upgradeCredentials = false }) {
	// Always request the default scope alongside whatever else was asked for. A token without it (e.g. from a login
	//   prompted by one resource's required scope) would make getAuthToken() prompt again on the very next request.
	scope = [...new Set([...defaultScope, ...(scope || [])])];

	// Sent along so that the new token is merged with the scopes and logins of the current one
	const headers = {};
	if (upgradeCredentials && cachedCredentials?.access_token) {
		headers.Authorization = getAuthorizationHeader(cachedCredentials.access_token);
	}

	const credentials = isNode
		? await performDeviceAuthorization({ scope, amrValues, headers })
		: await performPopupAuthorization({ scope, headers });

	await writeCachedCredentials(credentials);
}

async function performDeviceAuthorization({ scope, amrValues, headers }) {
	const { challenge, verifier } = await getPKCE();

	const deviceAuthorization = await parseOAuthResponse(
		await fetch(`${getBaseUrl()}/oauth/device_authorization`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: clientId,
				scope: scope.join(' '),
				amr_values: amrValues,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				access_type: 'offline',
			}),
		}),
	);

	const url = deviceAuthorization.verification_uri_complete;
	if (await openBrowser(url)) {
		console.log(`Please authenticate with your Redivis account. Opening browser to:\n${url}`);
	} else {
		console.log(`Please visit the URL below to authenticate with your Redivis account:\n${url}`);
	}

	const startedPollingAt = Date.now();
	while (true) {
		if (Date.now() - startedPollingAt > 10 * 60 * 1000) {
			throw new Error(`Timed out after 10 minutes while waiting for device authorization`);
		}
		await new Promise((resolve) => setTimeout(resolve, (deviceAuthorization.interval || 5) * 1000));

		const res = await fetch(`${getBaseUrl()}/oauth/token`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: clientId,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: deviceAuthorization.device_code,
				code_verifier: verifier,
			}),
		});
		if (res.status === 400) {
			const body = await res
				.clone()
				.json()
				.catch(() => ({}));
			if (body.error === 'authorization_pending') {
				continue;
			}
		}
		return parseOAuthResponse(res);
	}
}

async function openBrowser(url) {
	let command;
	let args;
	if (process.platform === 'darwin') {
		[command, args] = ['open', [url]];
	} else if (process.platform === 'win32') {
		// Unlike `start`, this doesn't need the URL's ampersands escaped
		[command, args] = ['rundll32', ['url.dll,FileProtocolHandler', url]];
	} else if (getEnv('DISPLAY') || getEnv('WAYLAND_DISPLAY')) {
		[command, args] = ['xdg-open', [url]];
	} else {
		// e.g. over SSH, where there's no browser to open
		return false;
	}

	const { spawn } = await importNodeModule('child_process');
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: 'ignore', detached: true });
		child.on('error', () => resolve(false));
		child.on('spawn', () => {
			child.unref();
			resolve(true);
		});
	});
}

async function performPopupAuthorization({ scope, headers }) {
	const redirectUri = 'urn:ietf:wg:oauth:2.0:oob:auto';
	const state = generateRandomString();
	const { challenge, verifier } = await getPKCE();
	const baseUrl = getBaseUrl();
	// Checked while the user signs in, so that the code exchange doesn't wait on it
	const useDpop = shouldUseDpop(baseUrl);
	// The consent screen shows this origin to the user, and only posts the code back to a page at it
	const { origin, protocol, hostname } = window.location;
	// Plain http is only allowed for local development
	if (protocol !== 'https:' && !(protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1'))) {
		throw new Error(`Redivis authentication requires the page to be served over https.`);
	}
	const params = {
		scope: scope.join(' '),
		redirect_uri: redirectUri,
		origin,
		response_type: 'code',
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256',
	};
	// Not URLSearchParams, since the consent screen decodes with decodeURIComponent, which leaves a + for a space
	const url = `${baseUrl}/oauth/authorize?${Object.entries(params)
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join('&')}`;
	const popupWindowSettings = 'toolbar=no,menubar=no,width=600,height=600,left=100,top=100';

	// Returns whether the popup opened, i.e. that the browser didn't block it
	function openPopup() {
		if (!popupWindowReference || popupWindowReference.closed) {
			popupWindowReference = window.open(url, 'Authorize Redivis', popupWindowSettings);
		}
		return (
			!!popupWindowReference && !popupWindowReference.closed && typeof popupWindowReference.closed !== 'undefined'
		);
	}

	return new Promise((resolve, reject) => {
		let popupClosedInterval;
		let removePrompt;
		// Registered for the whole login, so that a code sent just before the popup closed is still received
		window.addEventListener('message', onMessageEventHandler);

		if (openPopup()) {
			watchPopup();
		} else {
			// Popups are only allowed directly from a click, so ask the user to click through to sign in
			promptToSignIn();
		}

		function watchPopup() {
			popupWindowReference.focus();
			popupClosedInterval = setInterval(function () {
				if (!popupWindowReference || popupWindowReference.closed) {
					clearInterval(popupClosedInterval);
					// e.g. the user closed it by accident; let them reopen it, or cancel
					promptToSignIn({ wasPopupClosed: true });
				}
			}, 500);
		}

		function promptToSignIn({ wasPopupClosed = false } = {}) {
			let wasBlocked = false;
			removePrompt = showSignInPrompt({
				notice: wasPopupClosed ? `The sign-in window was closed before signing in finished.` : undefined,
				onSignIn() {
					if (!openPopup()) {
						wasBlocked = true;
						return false;
					}
					watchPopup();
					return true;
				},
				onCancel() {
					cleanUp();
					if (wasBlocked) {
						reject(
							new Error(
								`The Redivis authentication window was blocked by the browser. Please enable popups for this page and try again.`,
							),
						);
					} else if (wasPopupClosed) {
						reject(
							new Error(`The Redivis authentication window was prematurely closed. Please try again.`),
						);
					} else {
						reject(new Error(`Redivis authentication was cancelled.`));
					}
				},
			});
		}

		function cleanUp() {
			window.removeEventListener('message', onMessageEventHandler);
			clearInterval(popupClosedInterval);
			removePrompt?.();
		}

		// add the listener for receiving a message from the popup
		async function onMessageEventHandler(event) {
			if (event.origin !== baseUrl || event.source !== popupWindowReference) {
				return;
			}
			try {
				cleanUp();

				const { code, state: finalState } = JSON.parse(event.data);
				if (state !== finalState) {
					throw new Error(`An error occurred during login. Inconsistent state.`);
				}
				const tokenUrl = `${baseUrl}/oauth/token`;
				const requestToken = async () =>
					fetch(tokenUrl, {
						method: 'POST',
						headers: {
							...headers,
							'Content-Type': 'application/json',
							// Binds the token to this client's key, if the API supports it (see dpop.js)
							...((await useDpop) && { DPoP: await createDpopProof({ method: 'POST', url: tokenUrl }) }),
						},
						body: JSON.stringify({
							grant_type: 'authorization_code',
							code,
							redirect_uri: redirectUri,
							code_verifier: verifier,
						}),
					});
				let res = await requestToken();
				// A proof dated by a clock that's off is rejected, before the code is used, so the code can be exchanged
				//   again with a proof dated by the server's clock
				if (
					res.status === 400 &&
					(
						await res
							.clone()
							.json()
							.catch(() => ({}))
					).error === 'invalid_dpop_proof' &&
					syncClockWithServer(res, tokenUrl)
				) {
					res = await requestToken();
				}
				resolve(await parseOAuthResponse(res));
			} catch (e) {
				reject(e);
			}
		}
	});
}

async function parseOAuthResponse(res) {
	const body = await res.json().catch(() => ({}));
	if (res.status >= 400) {
		const err = new Error(body.error_description || body.error || `OAuth request failed with status ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return body;
}

async function getCredentialsPaths() {
	const os = await importNodeModule('os');
	const path = await importNodeModule('path');
	// Overridable for environments where the home directory isn't writable, or is shared between users
	const configDir = getConfigValue('configDir')?.replace(/^~(?=$|[\\/])/, os.homedir());
	const redivisDir = path.resolve(configDir || path.join(os.homedir(), '.redivis'));
	// Credentials are only valid for the environment that issued them. Those for redivis.com are kept directly in the
	//   config directory, and any other API endpoint's host (e.g. `localhost_8080`) has its own subdirectory. The
	//   Python and R clients name these directories the same way.
	const host = new URL(getApiEndpoint()).host.replace(/[^\w.-]/g, '_');
	const credentialsDir = host === 'redivis.com' ? redivisDir : path.join(redivisDir, 'environments', host);
	return { credentialsDir, credentialsFile: path.join(credentialsDir, 'js_credentials') };
}

async function loadCachedCredentials() {
	const credentialsFile = isNode ? (await getCredentialsPaths()).credentialsFile : undefined;
	// When there are no credentials, check again each time, in case another process has since logged in
	if (cachedCredentials && credentialsFile === cachedCredentialsFile) {
		return cachedCredentials;
	}
	const generation = credentialsGeneration;
	let credentials = null;
	try {
		if (isNode) {
			const { readFile } = await importNodeModule('fs/promises');
			credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
		} else {
			const storedCredentials = JSON.parse(sessionStorage.getItem(browserStorageKey));
			// A token bound to a DPoP key is useless without it, e.g. if the key couldn't be stored, and was lost with
			//   the page that created it
			const jkt = decodeAccessToken(storedCredentials)?.cnf?.jkt;
			if (!jkt || jkt === (await getDpopKeyThumbprint(getBaseUrl()))) {
				credentials = storedCredentials;
			}
		}
	} catch (e) {
		// ignore; there are no readable credentials
	}
	// Credentials written (or cleared) while this was reading are newer than what it read, e.g. when a concurrent
	//   request refreshed them
	if (generation === credentialsGeneration) {
		cachedCredentials = credentials;
		cachedCredentialsFile = credentialsFile;
	}
	return cachedCredentials || null;
}

async function writeCachedCredentials(credentials) {
	credentialsGeneration++;
	cachedCredentials = credentials;
	if (!isNode) {
		try {
			sessionStorage.setItem(browserStorageKey, JSON.stringify(credentials));
		} catch (e) {
			// ignore, e.g. storage is disabled; the credentials are still held in memory
		}
		return;
	}

	const { mkdir, open, rename, rm } = await importNodeModule('fs/promises');
	const path = await importNodeModule('path');
	const { credentialsDir, credentialsFile } = await getCredentialsPaths();
	cachedCredentialsFile = credentialsFile;
	// The file holds a refresh token, so keep it private to this user
	await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
	// Write a temporary file and swap it into place, so that another process never reads a partially written file.
	//   It's created readable only by this user, so the token is never exposed to others, even briefly.
	const tempPath = path.join(credentialsDir, `.js_credentials.${generateRandomString()}`);
	const handle = await open(tempPath, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(credentials, null, 2));
		await handle.close();
		await rename(tempPath, credentialsFile);
	} catch (e) {
		await handle.close().catch(() => {});
		await rm(tempPath, { force: true });
		throw e;
	}
}

async function clearCachedCredentials() {
	credentialsGeneration++;
	cachedCredentials = null;
	if (isNode) {
		const { rm } = await importNodeModule('fs/promises');
		const { credentialsFile } = await getCredentialsPaths();
		await rm(credentialsFile, { force: true });
	} else {
		try {
			sessionStorage.removeItem(browserStorageKey);
		} catch (e) {
			// ignore
		}
	}
}

async function getPKCE() {
	const verifier = generateRandomString();
	const challenge = await pkceChallengeFromVerifier(verifier);
	return { verifier, challenge };
}

function generateRandomString() {
	const array = new Uint32Array(56 / 2);
	crypto.getRandomValues(array);
	return Array.from(array, dec2hex).join('');
}

function dec2hex(dec) {
	return ('0' + dec.toString(16)).substr(-2);
}

function sha256(plain) {
	// returns promise ArrayBuffer
	const encoder = new TextEncoder();
	const data = encoder.encode(plain);
	return crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a) {
	// Convert the ArrayBuffer to string using Uint8 array.
	// btoa takes chars from 0-255 and base64 encodes.
	// Then convert the base64 encoded to base64url encoded.
	// (replace + with -, replace / with _, trim trailing =)
	const base64String = btoa(String.fromCharCode.apply(null, new Uint8Array(a)));
	return base64String.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkceChallengeFromVerifier(v) {
	const hashed = await sha256(v);
	return base64urlencode(hashed);
}
