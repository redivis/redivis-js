import { jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays } from 'apache-arrow';
import { Temporal } from 'temporal-polyfill';
import redivis from '../../index.js';
import Upload from '../../src/classes/Upload.js';
import { JobError, ValueError } from '../../src/common/errors.js';

const TABLE = '/tables/demo.ds.t';
const TEMP_URL = 'https://redivis.test/_tempStorageProxy/';

const table = () => redivis.table('demo.ds.t');

async function bodyText(body) {
	return body instanceof Blob ? body.text() : new TextDecoder().decode(body);
}

// Mocks a table that accepts uploads. `uploadStatus` is the status of a created upload.
function mockUploads({ existing = [], uploadStatus = 'completed', onTempUpload } = {}) {
	const tempUploads = [];
	const requests = mockFetch(async (request) => {
		const { method, path, url, body } = request;
		if (url.href.startsWith(TEMP_URL)) {
			return onTempUpload ? onTempUpload(request) : new Response(null, { status: 200 });
		}
		const uploadName = path.match(/\/uploads\/([^/]+)$/)?.[1];
		if (method === 'HEAD' && uploadName) {
			return new Response(null, { status: existing.includes(uploadName) ? 200 : 404 });
		} else if (method === 'DELETE' && uploadName) {
			return jsonResponse({});
		} else if (method === 'POST' && path === `${TABLE}/tempUploads`) {
			const results = body.tempUploads.map(({ size, resumable }, i) => ({
				id: `temp-${tempUploads.length + i}`,
				url: `${TEMP_URL}_/bucket/temp/${tempUploads.length + i}?signature=x`,
				size,
				resumable,
			}));
			tempUploads.push(...results);
			return jsonResponse({ results });
		} else if (method === 'POST' && path === `${TABLE}/uploads`) {
			return jsonResponse({ ...body, uri: `${TABLE}/uploads/${body.name}`, status: uploadStatus });
		} else if (method === 'POST' && path === `${TABLE}/rawFiles`) {
			return jsonResponse({});
		} else if (method === 'POST' && path.endsWith('/rows')) {
			return jsonResponse({ insertedRows: body.rows.length });
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});
	return { requests, tempUploads };
}

const apiRequests = (requests) =>
	requests.filter(({ url }) => !url.href.startsWith(TEMP_URL)).map(({ method, path }) => `${method} ${path}`);

test('uploads content via a temporary upload, then creates the upload', async () => {
	const { requests } = mockUploads();
	const progress = [];
	const file = new File(['a,b\n1,2\n'], 'data.csv');
	const upload = await table()
		.upload()
		.create(file, { delimiter: ',', onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded) });

	assert.equal(upload.name, 'data.csv');
	assert.equal(upload.getProperty('status'), 'completed');
	assert.deepEqual(apiRequests(requests), [
		`HEAD ${TABLE}/uploads/data_csv`,
		`POST ${TABLE}/tempUploads`,
		`POST ${TABLE}/uploads`,
	]);
	assert.deepEqual(requests[1].body, { tempUploads: [{ size: 8, name: 'data.csv', resumable: false }] });

	const put = requests.find(({ url }) => url.href.startsWith(TEMP_URL));
	assert.equal(put.method, 'PUT');
	assert.equal(await bodyText(put.rawBody), 'a,b\n1,2\n');
	assert.equal(put.headers.Authorization, undefined);

	assert.deepEqual(requests.at(-1).body, {
		name: 'data.csv',
		delimiter: ',',
		hasHeaderRow: true,
		skipBadRecords: false,
		allowJaggedRows: false,
		tempUploadId: 'temp-0',
	});
	assert.deepEqual(progress, [0, 8]);
});

test('handles name conflicts before uploading anything', async () => {
	let { requests } = mockUploads({ existing: ['data_csv'] });
	await assert.rejects(
		table()
			.upload('data.csv')
			.create(new Blob(['x'])),
		/already exists/,
	);
	assert.deepEqual(apiRequests(requests), [`HEAD ${TABLE}/uploads/data_csv`]);

	({ requests } = mockUploads({ existing: ['data_csv'] }));
	await table()
		.upload('data.csv')
		.create(new Blob(['x']), { replaceOnConflict: true, waitForFinish: false });
	assert.deepEqual(apiRequests(requests).slice(0, 2), [
		`HEAD ${TABLE}/uploads/data_csv`,
		`DELETE ${TABLE}/uploads/data_csv`,
	]);

	await assert.rejects(
		table()
			.upload('x')
			.create(new Blob(['x']), { replaceOnConflict: true, renameOnConflict: true }),
		ValueError,
	);
});

test('ifNotExists returns an existing upload without uploading', async () => {
	const requests = mockFetch(({ method }) =>
		method === 'HEAD'
			? new Response(null, { status: 200 })
			: jsonResponse({ name: 'data.csv', uri: `${TABLE}/uploads/data_csv`, status: 'completed' }),
	);
	const upload = await table()
		.upload('data.csv')
		.create(new Blob(['x']), { ifNotExists: true });
	assert.equal(upload.getProperty('status'), 'completed');
	assert.deepEqual(
		requests.map(({ method }) => method),
		['HEAD', 'GET'],
	);
});

test('uploads rows and arrow tables as newline-delimited JSON', async () => {
	const { requests } = mockUploads();
	await table()
		.upload('rows')
		.create([
			{ id: 9007199254740993n, when: Temporal.PlainDate.from('2020-01-02'), at: new Date(0), name: 'a' },
			{ id: 1n, name: null },
		]);
	const put = requests.find(({ url }) => url.href.startsWith(TEMP_URL));
	assert.equal(
		await bodyText(put.rawBody),
		'{"id":9007199254740993,"when":"2020-01-02","at":"1970-01-01T00:00:00.000Z","name":"a"}\n{"id":1,"name":null}',
	);
	assert.equal(requests.at(-1).body.type, 'jsonl');

	const { requests: arrowRequests } = mockUploads();
	await table()
		.upload('arrow')
		.create(tableFromArrays({ a: [1n, 2n], b: ['x', 'y'] }));
	const arrowPut = arrowRequests.find(({ url }) => url.href.startsWith(TEMP_URL));
	assert.equal(await bodyText(arrowPut.rawBody), '{"a":1,"b":"x"}\n{"a":2,"b":"y"}');

	await assert.rejects(table().upload('bad').create([1, 2]), /Each row must be an object/);
	await assert.rejects(table().upload('bad').create({ not: 'content' }), /Unknown option "not"/);
});

test('resumable uploads continue from where the server left off after an interruption', async () => {
	const MB = 2 ** 20;
	const size = 9 * MB;
	const data = new Uint8Array(size).map((_, i) => i % 251);
	// Stream the data in 1MB pieces, so that a range must be re-read from the stream's buffer after the interruption
	const stream = new ReadableStream({
		start(controller) {
			for (let i = 0; i < size; i += MB) controller.enqueue(data.slice(i, i + MB));
			controller.close();
		},
	});

	const received = new Uint8Array(size);
	let committed = 0;
	let failedOnce = false;
	const puts = [];
	const { requests } = mockUploads({
		onTempUpload: async ({ method, url, headers, rawBody }) => {
			if (method === 'POST') {
				assert.equal(headers['x-goog-resumable'], 'start');
				assert.equal(headers['x-upload-content-length'], String(size));
				return new Response(null, { status: 201, headers: { location: '/_tempStorageProxy/_/session/1' } });
			}
			assert.equal(url.pathname, '/_tempStorageProxy/_/session/1');
			const range = headers['Content-Range'];
			puts.push(range);
			if (range === `bytes */${size}`) {
				return new Response(null, { status: 308, headers: { range: `bytes=0-${committed - 1}` } });
			}
			const [, start, end] = range.match(/bytes (\d+)-(\d+)/).map(Number);
			if (start === 8 * MB && !failedOnce) {
				failedOnce = true;
				throw new TypeError('fetch failed');
			}
			received.set(new Uint8Array(await new Response(rawBody).arrayBuffer()), start);
			committed = end + 1;
			return committed === size
				? new Response(null, { status: 200 })
				: new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
		},
	});

	const progress = [];
	await table()
		.upload('big.bin')
		.create(stream, {
			size,
			waitForFinish: false,
			onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded),
		});

	assert.deepEqual(requests[1].body.tempUploads, [{ size, name: 'big.bin', resumable: true }]);
	assert.deepEqual(puts, [
		`bytes 0-${8 * MB - 1}/${size}`,
		`bytes ${8 * MB}-${size - 1}/${size}`,
		`bytes */${size}`,
		`bytes ${8 * MB}-${size - 1}/${size}`,
	]);
	assert.deepEqual(received, data);
	assert.deepEqual(progress, [0, 8 * MB, size]);
});

test('a ReadableStream requires a size', async () => {
	mockUploads();
	await assert.rejects(table().upload('x').create(new ReadableStream()), /size of a ReadableStream must be provided/);
});

test('failed imports throw a JobError, and can be removed', async () => {
	const { requests } = mockUploads({ uploadStatus: 'failed' });
	await assert.rejects(
		table()
			.upload('x')
			.create(new Blob(['x']), { removeOnFail: true }),
		JobError,
	);
	assert.equal(apiRequests(requests).at(-1), `DELETE ${TABLE}/uploads/x`);

	mockUploads({ uploadStatus: 'failed' });
	const upload = await table()
		.upload('y')
		.create(new Blob(['x']), { raiseOnFail: false });
	assert.equal(upload.getProperty('status'), 'failed');
});

test('inserts rows into a stream upload, keeping large integers exact', async () => {
	const { requests } = mockUploads();
	const upload = new Upload('stream', { table: table() });
	await upload.insertRows([{ id: 9007199254740993n, day: Temporal.PlainDate.from('2020-01-02') }]);
	assert.equal(requests[0].rawBody, '{"rows":[{"id":9007199254740993,"day":"2020-01-02"}]}');
	await assert.rejects(upload.insertRows({ id: 1 }), ValueError);
});

test('uploads are readable once imported', async () => {
	let status = 'running';
	mockFetch(({ method, path }) => {
		if (method === 'GET' && path === `${TABLE}/uploads/x`) {
			return jsonResponse({ name: 'x', uri: `${TABLE}/uploads/x`, status, numRows: 0 });
		} else if (path === `${TABLE}/uploads/x/variables`) {
			return jsonResponse({ results: [{ name: 'a', type: 'string' }] });
		} else if (path === `${TABLE}/uploads/x/readSessions`) {
			return jsonResponse({ numRows: 0, streams: [] });
		}
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
	const upload = table().upload('x');
	await assert.rejects(upload.toArrowTable(), /can't be read until it has been imported/);
	status = 'completed';
	assert.equal((await upload.toArrowTable()).numRows, 0);
	assert.equal((await upload.listVariables())[0].uri, `${TABLE}/uploads/x/variables/a`);
});

test('adds files to a file index table, in batches', async () => {
	const { requests } = mockUploads();
	const progress = [];
	await table().addFiles({
		files: [
			{ name: 'a.txt', data: 'hello' },
			new File(['world!'], 'b.txt'),
			{ name: 'c.bin', data: new Uint8Array(3) },
		],
		onProgress: (p) => progress.push(p),
	});

	assert.deepEqual(requests[0].body.tempUploads, [
		{ size: 5, name: 'a.txt', resumable: false },
		{ size: 6, name: 'b.txt', resumable: false },
		{ size: 3, name: 'c.bin', resumable: false },
	]);
	assert.deepEqual(requests.at(-1).body, {
		files: [
			{ name: 'a.txt', tempUploadId: 'temp-0' },
			{ name: 'b.txt', tempUploadId: 'temp-1' },
			{ name: 'c.bin', tempUploadId: 'temp-2' },
		],
	});
	assert.deepEqual(progress.at(-1), { bytesUploaded: 14, totalBytes: 14, filesUploaded: 3, totalFiles: 3 });

	await assert.rejects(table().addFiles({ files: [{ data: 'x' }] }), /must also have a `name`/);
	await assert.rejects(table().addFiles({}), /Exactly one of `files` or `directory`/);
});

test('adds the files of a local directory, skipping hidden ones', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'redivis-js-test-'));
	try {
		await mkdir(join(directory, 'nested'));
		await mkdir(join(directory, '.git'));
		await writeFile(join(directory, 'a.csv'), 'a');
		await writeFile(join(directory, 'nested', 'b.csv'), 'bb');
		await writeFile(join(directory, '.DS_Store'), 'x');
		await writeFile(join(directory, '.git', 'config'), 'x');

		const { requests } = mockUploads();
		await table().addFiles({ directory });
		assert.deepEqual(
			requests.at(-1).body.files.map(({ name }) => name),
			['a.csv', 'nested/b.csv'],
		);
		const puts = requests.filter(({ url }) => url.href.startsWith(TEMP_URL));
		assert.deepEqual((await Promise.all(puts.map(({ rawBody }) => bodyText(rawBody)))).sort(), ['a', 'bb']);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test('resumable uploads start a new session if theirs expired', async () => {
	const size = 9 * 2 ** 20;
	let sessions = 0;
	const calls = [];
	mockUploads({
		onTempUpload: ({ method, url, headers }) => {
			if (method === 'POST') {
				sessions++;
				return new Response(null, {
					status: 201,
					headers: { location: `/_tempStorageProxy/_/session/${sessions}` },
				});
			}
			calls.push(`${url.pathname.split('/').pop()} ${headers['Content-Range']}`);
			if (sessions === 1) {
				if (headers['Content-Range'].startsWith('bytes */')) {
					return new Response('Not found', { status: 404 });
				}
				throw new TypeError('fetch failed');
			}
			return headers['Content-Range'].endsWith(`-${size - 1}/${size}`)
				? new Response(null, { status: 200 })
				: new Response(null, { status: 308, headers: { range: `bytes=0-${2 ** 23 - 1}` } });
		},
	});
	await table()
		.upload('big')
		.create(new Blob([new Uint8Array(size)]), { waitForFinish: false });
	assert.equal(sessions, 2);
	assert.deepEqual(calls, [
		`1 bytes 0-${2 ** 23 - 1}/${size}`,
		`1 bytes */${size}`,
		`2 bytes 0-${2 ** 22 - 1}/${size}`,
		`2 bytes ${2 ** 23}-${size - 1}/${size}`,
	]);
});
