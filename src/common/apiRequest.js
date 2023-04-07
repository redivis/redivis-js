import { getRequestConfig } from './auth.js';
import avro from 'avsc';
import pMap from 'p-map';
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

class DateType extends avro.types.LogicalType {
	_fromValue(val) {
		// Date values are in days since epoch
		return new Date(val * 1000 * 60 * 60 * 24);
	}
}

class TimeType extends avro.types.LogicalType {
	_fromValue(val) {
		// Time values are stored in microseconds. Convert to milliseconds, Get the time portion, and remove the trailing 'Z'
		return new Date(val / 1000).toISOString().split('T')[1].slice(0, -1);
	}
}
class DateTimeType extends avro.types.LogicalType {
	_fromValue(val) {
		return new Date(val);
	}
}

export async function makeRowsRequest({ uri, maxResults, selectedVariables }) {
	const readSession = await makeRequest({
		method: 'POST',
		path: `${uri}/readSessions`,
		payload: {
			maxResults,
			selectedVariables,
			format: 'arrow',
		},
	});
	const parsedStreamData = await pMap(
		readSession.streams,
		async ({ id }) => {
			const rowsResponse = await makeRequest({
				method: 'GET',
				path: `/readStreams/${id}`,
				parseResponse: false,
			});
			const table = await tableFromIPC(rowsResponse);
			return table.toArray();
		},
		{ concurrency: 5 },
	);

	let finalResults = [].concat(...parsedStreamData);

	// Handle situations where the backend sends a few too many records, due to a known bug (TODO: remove once fixed)
	if (maxResults) {
		finalResults = finalResults.slice(0, maxResults);
	}
	return finalResults;
}
