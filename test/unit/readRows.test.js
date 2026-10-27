import { arrowResponse, jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	Bool,
	DateDay,
	Field,
	Float64,
	Int64,
	RecordBatch,
	Schema,
	Struct,
	TimeMicrosecond,
	TimestampMicrosecond,
	Utf8,
	makeData,
	makeVector,
	tableFromArrays,
	vectorFromArray,
} from 'apache-arrow';
import { Temporal } from 'temporal-polyfill';
import redivis from '../../index.js';
import { NetworkError, ValueError } from '../../src/common/errors.js';

const variables = [
	{ name: 'id', type: 'integer' },
	{ name: 'name', type: 'string' },
	{ name: 'score', type: 'float' },
];

// A batch of the `variables` above, with ids from `start`
function batch(start, length) {
	const ids = Array.from({ length }, (_, i) => start + i);
	return tableFromArrays({
		id: BigInt64Array.from(ids, BigInt),
		name: vectorFromArray(
			ids.map((id) => `row ${id}`),
			new Utf8(),
		),
		score: Float64Array.from(ids, (id) => id / 2),
	}).batches[0];
}

function ids(table) {
	return [...table.getChild('id')].map(Number);
}

// Mocks the API for a table: its properties and variables, its rows (`rows(request)`), and its read session's
//   streams (`streams[id](request)`)
function mockTable({ numRows = 10, numBytes = 1000, tableVariables = variables, rows, streams = {} } = {}) {
	return mockFetch(async (request) => {
		const { path, method } = request;
		if (path === '/tables/demo.ds.t' && method === 'GET') {
			return jsonResponse({ name: 't', uri: '/tables/demo.ds.t', numRows, numBytes });
		} else if (path === '/tables/demo.ds.t/variables') {
			return jsonResponse({ results: tableVariables });
		} else if (path === '/tables/demo.ds.t/rows') {
			return rows(request);
		} else if (path === '/tables/demo.ds.t/readSessions') {
			return jsonResponse({ numRows, streams: Object.keys(streams).map((id) => ({ id })) });
		} else if (path.startsWith('/readStreams/')) {
			return streams[path.split('/').pop()](request);
		}
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
}

const table = () => redivis.table('demo.ds.t');

test('reads small tables with a single listRows request', async () => {
	const requests = mockTable({ rows: () => arrowResponse([batch(0, 4), batch(4, 6)]) });
	const result = await table().toArrowTable();

	assert.deepEqual(ids(result), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	assert.deepEqual(
		result.schema.fields.map((field) => `${field}`),
		['id: Int64', 'name: Utf8', 'score: Float64'],
	);
	const rowsRequest = requests.find(({ path }) => path.endsWith('/rows'));
	assert.equal(rowsRequest.url.search, '?format=arrow');
});

test('selects variables case-insensitively, in the requested order', async () => {
	const requests = mockTable({
		rows: () => arrowResponse([tableFromArrays({ SCORE: Float64Array.from([1.5]), ID: [7n] }).batches[0]]),
	});
	const rows = await table().toRowsArray(1, { variables: ['Score', 'ID'] });

	assert.deepEqual(rows, [{ score: 1.5, id: 7 }]);
	const { url } = requests.find(({ path }) => path.endsWith('/rows'));
	assert.equal(url.searchParams.get('selectedVariables'), 'score,id');
	assert.equal(url.searchParams.get('maxResults'), '1');

	await assert.rejects(table().toArrowTable({ variables: ['nope'] }), ValueError);
});

test('large reads use a read session, resuming interrupted streams from their offset', async () => {
	let firstAttempt = true;
	const requests = mockTable({
		numBytes: 1e9,
		streams: {
			a: ({ url }) => {
				if (url.searchParams.get('offset') === '0' && firstAttempt) {
					firstAttempt = false;
					// Cut off after the first batch, without the end-of-stream sentinel
					return arrowResponse([batch(0, 2)]);
				}
				return arrowResponse([batch(Number(url.searchParams.get('offset')), 3)], { sentinel: true });
			},
			b: () => arrowResponse([batch(100, 2), batch(102, 2)], { sentinel: true }),
		},
	});
	const result = await table().toArrowTable({ maxParallelization: 2 });

	// Batches are kept in stream order
	assert.deepEqual(ids(result), [0, 1, 2, 3, 4, 100, 101, 102, 103]);
	const session = requests.find(({ path }) => path.endsWith('/readSessions'));
	assert.deepEqual(session.body, { requestedStreamCount: 2, format: 'arrow' });
	const offsets = requests
		.filter(({ path }) => path === '/readStreams/a')
		.map(({ url }) => [url.searchParams.get('offset'), url.searchParams.get('eosSentinel')]);
	assert.deepEqual(offsets, [
		['0', 'true'],
		['2', 'true'],
	]);
});

test('restarts an interrupted listRows read when reading into memory', async () => {
	let attempts = 0;
	mockTable({
		numRows: 6,
		rows: () => (++attempts === 1 ? arrowResponse([batch(0, 3)]) : arrowResponse([batch(0, 3), batch(3, 3)])),
	});
	const progress = [];
	const result = await table().toArrowTable({ onProgress: ({ rowsRead }) => progress.push(rowsRead) });

	assert.deepEqual(ids(result), [0, 1, 2, 3, 4, 5]);
	assert.equal(attempts, 2);
	// Progress rolls back when the rows are read again
	assert.deepEqual(progress, [3, 0, 3, 6]);
});

test('an iterator fails, rather than repeating rows, if a listRows read is interrupted', async () => {
	mockTable({ numRows: 6, rows: () => arrowResponse([batch(0, 3)]) });
	const seen = [];
	await assert.rejects(
		(async () => {
			for await (const b of table().toArrowBatchIterator()) seen.push(b.numRows);
		})(),
		(e) => e instanceof NetworkError && e.restartable,
	);
	assert.deepEqual(seen, [3]);
});

test('iterators are lazy, and stop reading when the loop exits', async () => {
	let signal;
	const requests = mockTable({
		numBytes: 1e9,
		streams: {
			a: (request) => {
				signal = request.signal;
				return arrowResponse([batch(0, 2), batch(2, 2)], { sentinel: true });
			},
		},
	});
	const iterator = table().toArrowBatchIterator();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(requests.length, 0);

	for await (const b of iterator) {
		assert.equal(b.numRows, 2);
		break;
	}
	assert.equal(signal.aborted, true);
});

test('applies maxResults, and batch preprocessors that can drop batches', async () => {
	mockTable({ rows: () => arrowResponse([batch(0, 4), batch(4, 4), batch(8, 2)]) });
	const result = await table().toArrowTable(6, {
		batchPreprocessor: (b) => (Number(b.getChild('id').get(0)) === 0 ? null : b),
	});
	// The server's response is capped too, but it's applied before the preprocessor
	assert.deepEqual(ids(result), [4, 5]);
});

test('returns an empty table with the variables as its schema', async () => {
	mockTable({ numRows: 0, rows: () => arrowResponse([batch(0, 0)]) });
	const result = await table().toArrowTable();
	assert.equal(result.numRows, 0);
	assert.deepEqual(
		result.schema.fields.map(({ name }) => name),
		['id', 'name', 'score'],
	);
});

test('enforces maxBytes before and during a read', async () => {
	const requests = mockTable({ numRows: 1000, numBytes: 5e8, rows: () => arrowResponse([batch(0, 1000)]) });
	await assert.rejects(table().toArrowTable({ maxBytes: 1e8 }), /exceeds the limit of 100MB/);
	assert.ok(!requests.some(({ path }) => path.endsWith('readSessions')));

	// A capped read is sized by the fraction of rows requested
	assert.equal((await table().toArrowTable(10, { maxBytes: 1e8 })).numRows, 10);

	// With selected variables, the size is only known as it arrives
	await assert.rejects(table().toArrowTable(10, { maxBytes: 1000, variables: ['id'] }), /exceeds the limit of 1kB/);
});

test('conforms streamed columns to the variable types', async () => {
	const tableVariables = [
		{ name: 'when', type: 'dateTime' },
		{ name: 'day', type: 'date' },
		{ name: 'time', type: 'time' },
		{ name: 'count', type: 'integer' },
		{ name: 'flag', type: 'boolean' },
		{ name: 'missing', type: 'float' },
	];
	const strings = (values) => vectorFromArray(values, new Utf8());
	const streamed = tableFromArrays({
		when: strings(['2023-09-26 03:33:56.251', '1969-12-31T23:59:59.999999Z', null]),
		day: strings(['2020-02-29', '', '0001-01-01']),
		time: strings(['13:04:05.5', '00:00', null]),
		count: strings(['42', '-7', null]),
		flag: strings(['true', 'FALSE', '1']),
	}).batches[0];
	mockTable({ numRows: 3, tableVariables, rows: () => arrowResponse([streamed]) });

	const result = await table().toArrowTable();
	assert.deepEqual(
		result.schema.fields.map((field) => `${field}`),
		[
			'when: Timestamp<MICROSECOND>',
			'day: Date32<DAY>',
			'time: Time64<MICROSECOND>',
			'count: Int64',
			'flag: Bool',
			'missing: Float64',
		],
	);

	const rows = await table().toRowsArray();
	assert.deepEqual(
		rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? null : String(v)]))),
		[
			{
				when: '2023-09-26T03:33:56.251',
				day: '2020-02-29',
				time: '13:04:05.5',
				count: '42',
				flag: 'true',
				missing: null,
			},
			{
				when: '1969-12-31T23:59:59.999999',
				day: null,
				time: '00:00:00',
				count: '-7',
				flag: 'false',
				missing: null,
			},
			{ when: null, day: '0001-01-01', time: null, count: null, flag: 'true', missing: null },
		],
	);

	await assert.rejects(
		(async () => {
			mockTable({
				numRows: 1,
				tableVariables: [{ name: 'count', type: 'integer' }],
				rows: () => arrowResponse([tableFromArrays({ count: strings(['nope']) }).batches[0]]),
			});
			await table().toArrowTable();
		})(),
		/Couldn't convert the value "nope" of variable "count"/,
	);
});

test('converts columns to strings as BigQuery casts them', async () => {
	// E.g., a variable that's a string because its uploads disagreed on its type
	const raw = (type, values) =>
		makeVector(makeData({ type, length: values.length, nullCount: 0, data: BigInt64Array.from(values) }));
	const streamed = tableFromArrays({
		day: vectorFromArray([new Date('2020-01-02'), new Date('0001-01-01T00:00:00Z'), null], new DateDay()),
		when: raw(new TimestampMicrosecond(), [1577934245000000n, 1577934245120000n, -1n]),
		time: raw(new TimeMicrosecond(), [11045000000n, 11045000001n, 86399500000n]),
		count: vectorFromArray([1n, -2n, null], new Int64()),
		score: Float64Array.from([1, 0.5, 0.1]),
		flag: vectorFromArray([true, false, null], new Bool()),
	}).batches[0];
	const tableVariables = ['day', 'when', 'time', 'count', 'score', 'flag'].map((name) => ({ name, type: 'string' }));
	mockTable({ numRows: 3, tableVariables, rows: () => arrowResponse([streamed]) });

	const result = await table().toArrowTable();

	assert.deepEqual(
		result.schema.fields.map(({ type }) => `${type}`),
		Array(6).fill('Utf8'),
	);
	assert.deepEqual(result.toArray().map((row) => row.toJSON()), [
		{ day: '2020-01-02', when: '2020-01-02 03:04:05', time: '03:04:05', count: '1', score: '1', flag: 'true' },
		{
			day: '0001-01-01',
			when: '2020-01-02 03:04:05.120',
			time: '03:04:05.000001',
			count: '-2',
			score: '0.5',
			flag: 'false',
		},
		{ day: null, when: '1969-12-31 23:59:59.999999', time: '23:59:59.500', count: null, score: '0.1', flag: null },
	]);
});

test('reads through a read session when listRows requires one', async () => {
	const readSessionRequired = () =>
		jsonResponse(
			{ status: 400, error: 'read_session_required', error_description: 'Use a read session' },
			{ status: 400 },
		);
	const streams = { s1: () => arrowResponse([batch(0, 10)], { sentinel: true }) };

	let requests = mockTable({ rows: readSessionRequired, streams });
	assert.deepEqual(ids(await table().toArrowTable()), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	assert.deepEqual(
		requests.map(({ path }) => path).filter((path) => /rows|readSessions|readStreams/.test(path)),
		['/tables/demo.ds.t/rows', '/tables/demo.ds.t/readSessions', '/readStreams/s1'],
	);

	requests = mockTable({ rows: readSessionRequired, streams });
	const batches = [];
	for await (const batch of table().toArrowBatchIterator()) {
		batches.push(batch);
	}
	assert.equal(
		batches.reduce((count, { numRows }) => count + numRows, 0),
		10,
	);
	assert.ok(requests.some(({ path }) => path.endsWith('/readSessions')));

	// Other errors are raised, rather than retried
	requests = mockTable({
		rows: () => jsonResponse({ status: 400, error: 'invalid_request', error_description: 'No' }, { status: 400 }),
		streams,
	});
	await assert.rejects(table().toArrowTable(), /No/);
	assert.ok(!requests.some(({ path }) => path.endsWith('/readSessions')));
});

test('toRowsArray converts values to JS types', async () => {
	const tableVariables = [
		{ name: 'when', type: 'dateTime' },
		{ name: 'day', type: 'date' },
		{ name: 'time', type: 'time' },
		{ name: 'big', type: 'integer' },
		{ name: 'flag', type: 'boolean' },
	];
	const fields = [
		new Field('when', new TimestampMicrosecond()),
		new Field('day', new DateDay()),
		new Field('time', new TimeMicrosecond()),
		new Field('big', new Int64()),
		new Field('flag', new Bool()),
	];
	const children = [
		makeData({ type: fields[0].type, length: 1, data: new BigInt64Array([-1n]) }),
		makeData({ type: fields[1].type, length: 1, data: new Int32Array([-1]) }),
		makeData({ type: fields[2].type, length: 1, data: new BigInt64Array([45_296_000_007n]) }),
		makeData({ type: fields[3].type, length: 1, data: new BigInt64Array([9007199254740993n]) }),
		vectorFromArray([true], new Bool()).data[0],
	];
	const streamed = new RecordBatch(
		new Schema(fields),
		makeData({ type: new Struct(fields), length: 1, nullCount: 0, children }),
	);
	mockTable({ numRows: 1, tableVariables, rows: () => arrowResponse([streamed]) });

	const [row] = await table().toRowsArray();
	assert.ok(row.when instanceof Temporal.PlainDateTime);
	assert.equal(row.when.toString(), '1969-12-31T23:59:59.999999');
	assert.ok(row.day.equals(Temporal.PlainDate.from('1969-12-31')));
	assert.equal(row.time.toString(), '12:34:56.000007');
	assert.equal(row.big, 9007199254740992);
	assert.equal(row.flag, true);

	const [plain] = await table().toRowsArray({ temporal: false, bigInt: true });
	assert.deepEqual(plain, {
		when: new Date(-1),
		day: new Date('1969-12-31'),
		time: '12:34:56.000007',
		big: 9007199254740993n,
		flag: true,
	});
});

test('queries are read once they finish', async () => {
	let polls = 0;
	const requests = mockFetch(({ path, method }) => {
		if (path === '/queries' && method === 'POST') {
			return jsonResponse({ id: 'q1', uri: '/queries/q1', status: 'running' });
		} else if (path === '/queries/q1') {
			polls++;
			return jsonResponse({
				id: 'q1',
				uri: '/queries/q1',
				status: 'completed',
				outputNumRows: 2,
				outputNumBytes: 10,
			});
		} else if (path === '/queries/q1/variables') {
			return jsonResponse({ results: variables });
		} else if (path === '/queries/q1/rows') {
			return arrowResponse([batch(0, 2)]);
		}
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
	const rows = await redivis.query('SELECT 1').toRowsArray();
	assert.deepEqual(rows, [
		{ id: 0, name: 'row 0', score: 0 },
		{ id: 1, name: 'row 1', score: 0.5 },
	]);
	assert.equal(polls, 1);
	assert.equal(requests.filter(({ path }) => path === '/queries').length, 1);
});

test('toReadStreams() splits a read across independently readable streams', async () => {
	const requests = mockTable({
		streams: {
			s1: () => arrowResponse([batch(0, 2)], { sentinel: true }),
			s2: () => arrowResponse([batch(2, 3)], { sentinel: true }),
		},
	});
	const streams = await table().toReadStreams(2, { variables: ['ID'] });
	assert.deepEqual(
		streams.map((stream) => stream.uri),
		['/readStreams/s1', '/readStreams/s2'],
	);
	const session = requests.find(({ path }) => path.endsWith('/readSessions'));
	assert.deepEqual(session.body, { requestedStreamCount: 2, format: 'arrow', selectedVariables: ['id'] });

	const second = await streams[1].toArrowTable();
	assert.deepEqual(ids(second), [2, 3, 4]);
	// Only the selected variable
	assert.deepEqual(
		second.schema.fields.map(({ name }) => name),
		['id'],
	);
	assert.equal((await streams[0].toRowsArray(1)).length, 1);
	await assert.rejects(streams[0].toArrowTable({ variables: ['name'] }), ValueError);
});

test('validates read options', () => {
	assert.throws(() => table().toArrowBatchIterator(-1), ValueError);
	assert.throws(() => table().toArrowBatchIterator({ maxParallelization: 0 }), ValueError);
	assert.throws(() => table().toArrowBatchIterator({ maxBytes: 1 }), /Unknown option "maxBytes"/);
});
