import { getAuthToken } from './auth.js';
import avro from 'avsc';
import pMap from 'p-map';

let fetch;
if (typeof window !== 'undefined') {
	fetch = window.fetch;
}

if (typeof process !== 'undefined') {
	if (process.env?.REDIVIS_API_ENDPOINT && process.env.REDIVIS_API_ENDPOINT.startsWith('https://localhost')) {
		process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = 0;
	}
}

function getApiEndpoint() {
	if (typeof process !== 'undefined') {
		return process.env?.REDIVIS_API_ENDPOINT || 'https://redivis.com/api/v1';
	} else {
		return 'https://redivis.com/api/v1';
	}
}

export async function makeRequest({
	method,
	path,
	query,
	payload,
	parseResponse = true,
	forceReauthorization = false,
}) {
	let url = `${getApiEndpoint()}${path}`;
	const authToken = await getAuthToken({ forceReauthorization });
	const headers = { Authorization: `Bearer ${authToken}` };

	if (query) {
		url += `?${Object.entries(query)
			.map(([key, value]) => `${key}=${value}`)
			.join('&')}`;
	}

	if (payload) {
		payload = JSON.stringify(payload);
		headers['Content-Type'] = 'application/json';
	}
	if (!fetch) {
		const { default: nodeFetch } = await import('node-fetch');
		fetch = nodeFetch;
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
		if (response.status === 401) {
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

export async function makeRowsRequest({ uri, maxResults, selectedVariables, format }) {
	const readSession = await makeRequest({
		method: 'POST',
		path: `${uri}/readSession`,
		payload: {
			maxResults,
			selectedVariables,
			format,
		},
	});
	console.log(readSession);
	const parsedStreamData = await pMap(
		readSession.streams,
		async ({ id, schemaIndex }) => {
			const avroType = avro.Type.forSchema(readSession.avroSchemas[schemaIndex], {
				logicalTypes: { 'time-micros': TimeType, datetime: DateTimeType, date: DateType },
			});

			// let a = Date.now();

			const avroRes = await makeRequest({
				method: 'GET',
				path: `/readStreams/${encodeURIComponent(id)}`,
				parseResponse: false,
				query: {
					offset: 0,
				},
			});
			const arrayBuffer = await avroRes.arrayBuffer();

			// console.log('got row data in ', Date.now() - a);
			// a = Date.now();

			const buff = Buffer.from(arrayBuffer);

			const data = [];

			let pos;
			do {
				const decodedData = avroType.decode(buff, pos);
				pos = decodedData.offset; // pos is the byte position in the avro binary. Will be -1 once buffer is fully read

				if (decodedData.value) {
					data.push(decodedData.value);
				}
			} while (pos > 0);

			// console.log('parsed data in ', Date.now() - a);

			return data;
		},
		{ concurrency: 5 },
	);

	return [].concat(...parsedStreamData);
}
