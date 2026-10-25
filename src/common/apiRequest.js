import { canReauthorize, getRequestConfig, refreshCredentials } from './auth.js';
import { createApiError, NetworkError } from './errors.js';
import { isNode } from './node.js';
import { tableFromIPC } from 'apache-arrow';
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
		body = JSON.stringify(payload);
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
 * @returns {Promise<object[]>}
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

function sleep(ms, signal) {
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

// TODO: use temporal for dates + times
// Dates do seem to come down as actual dates, but maybe in the future we'll use Temporal API
function dateTransformer(val) {
	return new Date(val);
}

function dateTimeTransformer(val) {
	return new Date(val);
}

// Times are stored as a bigint representing microseconds. Convert to seconds as a standard Number (not bigint)
function timeTransformer(val) {
	return Number(val) / 1e6;
}

// Map BigInts to javascript numbers
// TODO: in the future, this should be configurable
function integerTransformer(val) {
	return Number(val);
}

export async function makeRowsRequest({
	uri,
	maxResults,
	mappedVariables,
	selectedVariables,
	createReadSession = true,
	requestedStreamCount = 1, // 1 seems to be the fastest
}) {
	const variableTypeTransformerMap = new Map(
		mappedVariables
			.map((variable) => {
				if (variable.type === 'integer') {
					return [variable.name.toLowerCase(), integerTransformer];
				} else if (variable.type === 'date') {
					return [variable.name.toLowerCase(), dateTransformer];
				} else if (variable.type === 'dateTime') {
					return [variable.name.toLowerCase(), dateTimeTransformer];
				} else if (variable.type === 'time') {
					return [variable.name.toLowerCase(), timeTransformer];
				}
			})
			.filter((val) => val),
	);

	let finalResults;
	if (createReadSession) {
		const readSession = await makeRequest({
			method: 'POST',
			path: `${uri}/readSessions`,
			payload: {
				maxResults,
				selectedVariables: selectedVariables,
				format: 'arrow',
				requestedStreamCount,
			},
		});

		const parsedStreamData = await Promise.all(
			readSession.streams.map(async ({ id }) => {
				const response = await makeRequest({
					method: 'GET',
					path: `/readStreams/${id}`,
					parseResponse: false,
				});
				return parseArrowStream(response, variableTypeTransformerMap);
			}),
		);

		finalResults = [].concat(...parsedStreamData);
	} else {
		const arrowResponse = await makeRequest({
			method: 'GET',
			path: `${uri}/rows`,
			parseResponse: false,
			query: {
				maxResults,
				selectedVariables,
				format: 'arrow',
			},
		});

		finalResults = await parseArrowStream(arrowResponse, variableTypeTransformerMap);
	}

	return finalResults;
}

async function parseArrowStream(response, variableTypeTransformerMap) {
	const table = await tableFromIPC(response);
	const casedVariableTypeTransformerMap = new Map(
		table.schema.fields
			.map(({ name }) => {
				if (variableTypeTransformerMap.has(name.toLowerCase())) {
					return [name, variableTypeTransformerMap.get(name.toLowerCase())];
				}
			})
			.filter((val) => val),
	);

	const mappedArray = table.toArray().map((row) => row.toJSON()); // Converts the rows to JS arrays of values

	for (const row of mappedArray) {
		for (const [name, transformer] of casedVariableTypeTransformerMap.entries()) {
			if (row[name] !== null) {
				row[name] = transformer(row[name]);
			}
		}
	}

	return mappedArray;
}
