import { canReauthorize, getRequestConfig, refreshCredentials } from './auth.js';
import { createApiError, NetworkError } from './errors.js';
import { jsonReplacer } from './json.js';
import { isNode } from './node.js';
import packageJson from '../../package.json' with { type: 'json' };

const { version } = packageJson;

// A backstop on authentication retries, in case the server's failures keep changing without ever succeeding
const MAX_AUTH_ATTEMPTS = 5;
// Retries for a 503 (and, for idempotent requests, network failures), with linear backoff
const MAX_RETRIES = 10;

const printedWarnings = new Set();

/**
 * Makes a request to the Redivis API, authenticating as needed.
 *
 * @param {object} options
 * @param {string} [options.method='GET']
 * @param {string} options.path Path relative to the API root, e.g. `/users/me`
 * @param {object} [options.query] Query parameters; array values are sent as repeated parameters
 * @param {object} [options.payload] Request body, sent as JSON
 * @param {object} [options.headers] Additional request headers
 * @param {boolean} [options.parseResponse=true] Whether to parse the response body (as JSON when it's JSON, text
 *   otherwise). If false, the raw `Response` is returned.
 * @param {RequestCache} [options.cache] The fetch cache mode
 * @param {AbortSignal} [options.signal]
 * @param {string[]} [options.authFailures] Internal: the authentication failures so far
 * @param {number} [options.retryCount] Internal: the number of retries so far
 * @returns {Promise<any>}
 */
export async function makeRequest({
	method = 'GET',
	path,
	query,
	payload,
	headers: extraHeaders,
	parseResponse = true,
	cache,
	signal,
	authFailures = [],
	retryCount = 0,
}) {
	const { baseUrl, headers = {} } = await getRequestConfig();

	headers['X-Redivis-Client'] = 'redivis-js';
	headers['X-Redivis-Client-Version'] = version;
	if (isNode) {
		// Browsers don't allow setting the User-Agent
		headers['User-Agent'] = `redivis-js/${version}`;
	}
	Object.assign(headers, extraHeaders);

	const url = `${baseUrl}${path}${toQueryString(query)}`;

	let body;
	if (payload !== undefined) {
		body = JSON.stringify(payload, jsonReplacer);
		headers['Content-Type'] = 'application/json';
	}

	const retry = (overrides) =>
		makeRequest({
			method,
			path,
			query,
			payload,
			headers: extraHeaders,
			parseResponse,
			cache,
			signal,
			authFailures,
			retryCount,
			...overrides,
		});

	let response;
	try {
		response = await fetch(url, { method, headers, body, cache, signal });
	} catch (e) {
		if (signal?.aborted) {
			throw e;
		}
		// Only idempotent requests are safe to repeat, since we can't know whether the server received the original
		if ((method === 'GET' || method === 'HEAD') && retryCount < MAX_RETRIES) {
			await sleep(retryCount * 1000, signal);
			return retry({ retryCount: retryCount + 1 });
		}
		throw new NetworkError(`${method} ${path} failed`, { cause: e });
	}

	if (response.status === 503 && retryCount < MAX_RETRIES) {
		await response.body?.cancel();
		await sleep(retryCount * 1000, signal);
		return retry({ retryCount: retryCount + 1 });
	}

	const warning = response.headers.get('x-redivis-warning');
	if (warning && !printedWarnings.has(warning)) {
		printedWarnings.add(warning);
		console.warn(warning);
	}

	if (response.status >= 400) {
		const parsedResponse = await parseErrorResponse(response, method);
		const { error, error_description, scope, amr_values } =
			parsedResponse && typeof parsedResponse === 'object' ? parsedResponse : {};

		const isAuthFailure = response.status === 401 || (response.status === 403 && error === 'insufficient_scope');
		// Authenticating is only worth retrying while it makes progress, i.e. each attempt fails differently than the
		//   ones before it: an anonymous request that's rejected, then a scope upgrade after logging in, and so on. Once
		//   a failure repeats, re-authenticating can't help, and retrying anyway would loop forever.
		const authFailure =
			isAuthFailure &&
			JSON.stringify({
				status: response.status,
				authenticated: !!headers.Authorization,
				error,
				error_description,
				scope,
				amr_values,
			});

		if (
			isAuthFailure &&
			canReauthorize() &&
			!authFailures.includes(authFailure) &&
			authFailures.length < MAX_AUTH_ATTEMPTS
		) {
			console.warn(`${error}: ${error_description || 'Authentication is required to access this resource.'}`);
			await refreshCredentials({
				scope: scope?.split(' '),
				amrValues: amr_values,
				rejectedToken: headers.Authorization?.replace(/^Bearer /, ''),
			});
			return retry({ authFailures: [...authFailures, authFailure] });
		}

		throw createApiError(response.status, parsedResponse);
	}

	if (!parseResponse) {
		return response;
	}
	if (method === 'HEAD' || response.status === 204) {
		return null;
	}
	if (response.headers.get('content-type')?.startsWith('application/json')) {
		return response.json();
	}
	return response.text();
}

/**
 * Fetches every page of a paginated API listing, up to `maxResults` results.
 * @param {{path: string, pageSize?: number, query?: Record<string, any>, maxResults?: number | null, signal?: AbortSignal}} options
 * @returns {Promise<any[]>}
 */
export async function makePaginatedRequest({ path, pageSize = 100, query = {}, maxResults, signal }) {
	const results = [];
	let nextPageToken;

	while (maxResults === undefined || maxResults === null || results.length < maxResults) {
		const response = await makeRequest({
			method: 'GET',
			path,
			signal,
			query: {
				...query,
				pageToken: nextPageToken,
				maxResults:
					maxResults === undefined || maxResults === null
						? pageSize
						: Math.min(pageSize, maxResults - results.length),
			},
		});
		results.push(...response.results);
		nextPageToken = response.nextPageToken;
		if (!nextPageToken) {
			break;
		}
	}
	return maxResults === undefined || maxResults === null ? results : results.slice(0, maxResults);
}

function toQueryString(query) {
	if (!query) return '';

	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined || value === null) continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== undefined && item !== null) {
					params.append(key, String(item));
				}
			}
		} else {
			params.append(key, String(value));
		}
	}
	const queryString = params.toString();
	return queryString ? `?${queryString}` : '';
}

async function parseErrorResponse(response, method) {
	// A HEAD response has no body, so the API sends the error in a header instead
	if (method === 'HEAD') {
		const errorPayload = response.headers.get('x-redivis-error-payload');
		if (!errorPayload) {
			return { error: response.status === 404 ? 'not_found' : 'unknown_error' };
		}
		try {
			return JSON.parse(decodeURIComponent(errorPayload));
		} catch (e) {
			return decodeURIComponent(errorPayload);
		}
	}
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch (e) {
		return text;
	}
}

// Resolves after `ms`, or rejects as soon as the signal aborts
export function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			return reject(signal.reason);
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeout);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}
