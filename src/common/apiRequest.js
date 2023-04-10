import { getRequestConfig } from './auth.js';
import { tableFromIPC } from 'apache-arrow';

export async function makeRequest({
	method,
	path,
	query,
	payload,
	parseResponse = true,
	forceReauthorization = false,
}) {
	const { baseUrl, headers = {} } = await getRequestConfig({ forceReauthorization });

	let url = `${baseUrl}${path}`;

	if (query) {
		url += `?${Object.entries(query)
			.map(([key, value]) => `${key}=${value}`)
			.join('&')}`;
	}

	if (payload) {
		payload = JSON.stringify(payload);
		headers['Content-Type'] = 'application/json';
	}

	const response = await fetch(url, { method, headers, body: payload });
	let parsedResponse = response;

	if (parseResponse) {
		if (response.headers.get('content-type')?.startsWith?.('application/json')) {
			parsedResponse = await response.json();
		} else {
			parsedResponse = await response.text();
		}
	}

	if (response.status >= 400) {
		if (response.status === 401 && !forceReauthorization) {
			return makeRequest({ method, path, query, payload, forceReauthorization: true });
		}
		const err = new Error(parsedResponse.error?.message || parsedResponse);
		if (parsedResponse.error) {
			for (const [key, value] of Object.entries(parsedResponse.error)) {
				err[key] = value;
			}
		}
		err.status = response.status;
		throw err;
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

function floatTransformer(val) {
	return Number(val);
}

// Map BigInts to javascript numbers
// TODO: in the future, this should be configurable
function integerTransformer(val) {
	return Number(val);
}

function booleanTransformer(val) {
	return val === 'true';
}

export async function makeRowsRequest({ uri, maxResults, mappedVariables, selectedVariables }) {
	const readSession = await makeRequest({
		method: 'POST',
		path: `${uri}/readSessions`,
		payload: {
			maxResults,
			selectedVariables: selectedVariables,
			format: 'arrow',
		},
	});
	const variableTypeTransformerMap = new Map(
		mappedVariables
			.map((variable) => {
				if (variable.type === 'float') {
					return [variable.name.toLowerCase(), floatTransformer];
				} else if (variable.type === 'integer') {
					return [variable.name.toLowerCase(), integerTransformer];
				} else if (variable.type === 'date') {
					return [variable.name.toLowerCase(), dateTransformer];
				} else if (variable.type === 'dateTime') {
					return [variable.name.toLowerCase(), dateTimeTransformer];
				} else if (variable.type === 'time') {
					return [variable.name.toLowerCase(), timeTransformer];
				} else if (variable.type === 'boolean') {
					return [variable.name.toLowerCase(), booleanTransformer];
				}
			})
			.filter((val) => val),
	);
	const parsedStreamData = await Promise.all(
		readSession.streams.map(async ({ id }) => {
			const rowsResponse = await makeRequest({
				method: 'GET',
				path: `/readStreams/${id}`,
				parseResponse: false,
			});
			const table = await tableFromIPC(rowsResponse);
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
		}),
	);

	let finalResults = [].concat(...parsedStreamData);

	// Handle situations where the backend sends a few too many records, due to a known bug (TODO: remove once fixed)
	if (maxResults) {
		finalResults = finalResults.slice(0, maxResults);
	}
	return finalResults;
}
