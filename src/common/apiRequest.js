import { getRequestConfig } from './auth.js';
import { tableFromIPC } from 'apache-arrow';
import packageJSON from '../../package.json' with { type: 'json' };

export async function makeRequest({
	method,
	path,
	query,
	payload,
	parseResponse = true,
	forceReauthorization = false,
}) {
	const { baseUrl, headers = {} } = await getRequestConfig({ forceReauthorization });

	const version = packageJSON.version;
	headers['X-Redivis-Client'] = 'redivis-js';
	headers['X-Redivis-Client-Version'] = version;
	headers['User-Agent'] = typeof window === 'undefined' ? `redivis-js/${{ version }}` : window.navigator.userAgent;

	let url = `${baseUrl}${path}`;

	if (query) {
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
		if (queryString) {
			url += `?${queryString}`;
		}
	}

	if (payload) {
		payload = JSON.stringify(payload);
		headers['Content-Type'] = 'application/json';
	}

	const response = await fetch(url, { method, headers, body: payload });

	let parsedResponse = response;

	if (response.status >= 400) {
		if (response.status === 401 && !forceReauthorization) {
			return makeRequest({ method, path, query, payload, forceReauthorization: true });
		}
		if (response.headers.get('content-type')?.startsWith?.('application/json')) {
			parsedResponse = await response.json();
		} else {
			parsedResponse = await response.text();
		}

		const err = new Error(parsedResponse.error_description || parsedResponse.error || parsedResponse);
		err.status = response.status;
		throw err;
	}

	if (parseResponse) {
		if (response.headers.get('content-type')?.startsWith?.('application/json')) {
			parsedResponse = await response.json();
		} else {
			parsedResponse = await response.text();
		}
	}
	return parsedResponse;
}

export async function makePaginatedRequest({ path, pageSize = 100, query = {}, maxResults }) {
	const results = [];
	let page = 0;
	let nextPageToken;

	while (true) {
		if (maxResults && results.length >= maxResults) break;

		if (nextPageToken) {
			query.pageToken = nextPageToken;
		}

		const response = await makeRequest({
			method: 'GET',
			path,
			query: {
				...query,
				maxResults:
					maxResults === undefined || (page + 1) * pageSize < maxResults
						? pageSize
						: maxResults - page * pageSize,
			},
		});
		page++;
		results.push(...response.results);
		nextPageToken = response.nextPageToken;
		if (!nextPageToken) {
			break;
		}
	}
	return results;
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

	let finalResults
	if (createReadSession){
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
		})

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