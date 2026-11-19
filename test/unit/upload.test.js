import { API_ROOT, jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays } from 'apache-arrow';
import { Temporal } from 'temporal-polyfill';
import redivis from '../../index.js';
import Upload from '../../src/classes/Upload.js';
import { JobError, NetworkError, ValueError } from '../../src/common/errors.js';
import { encodeImportFileName, IMPORT_SETTINGS } from '../../src/common/imports.js';
import { bytesToBase64, Md5 } from '../../src/common/md5.js';

const TABLE = '/tables/demo.ds.t';
const KiB = 2 ** 10;

// Small enough that the tests exercise the upload session without megabytes of data, and quick to retry and poll
Object.assign(IMPORT_SETTINGS, {
	directUploadMaxBytes: 64 * KiB,
	minChunkBytes: 16 * KiB,
	startChunkBytes: 32 * KiB,
	maxChunkBytes: 32 * KiB,
	hashReadBytes: 16 * KiB,
	retryDelayMs: 1,
	pollIntervalMs: 1,
	maxPollIntervalMs: 1,
});

const table = () => redivis.table('demo.ds.t');

const md5 = (bytes) => createHash('md5').update(bytes).digest('base64');
const decodeName = (encoded) => Buffer.from(encoded, 'base64url').toString();

async function toBytes(body) {
	if (body === undefined || body === null) return new Uint8Array(0);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	return new Uint8Array(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength);
}
const toText = async (body) => new TextDecoder().decode(await toBytes(body));

/**
 * Mocks a table that accepts imports.
 *
 * @param {object} [options]
 * @param {string[]} [options.existing] The (escaped) names of the table's existing uploads
 * @param {string[]} [options.statuses] The statuses a processing import reports on each poll, the last repeating
 * @param {string} [options.errorMessage] The error message of a failed import
 * @param {(request, state) => Response | undefined} [options.onRequest] Handles a request first, if it returns one
 */
function mockImports({ existing = [], statuses = ['completed'], errorMessage, onRequest } = {}) {
	const state = {
		imports: [],
		// The files uploaded to the import, by name
		files: {},
		// Upload sessions by upload_id: their file name, size, md5, received bytes, and whether they're dead
		sessions: {},
		polls: 0,
	};
	const importResponse = (dataImport) => ({
		kind: 'import',
		id: dataImport.id,
		uri: `/imports/${dataImport.id}`,
		name: dataImport.name,
		status: dataImport.status,
		type: dataImport.type,
		totalFileCount: dataImport.totalFileCount,
		transferredFileCount: Object.keys(state.files).length,
		errorMessage: dataImport.status === 'failed' ? errorMessage : undefined,
	});

	const requests = mockFetch(async (request) => {
		const handled = await onRequest?.(request, state);
		if (handled) return handled;

		const { method, path, url, body, rawBody, headers } = request;
		const uploadName = path.match(/^\/tables\/[^/]+\/uploads\/([^/]+)$/)?.[1];
		if (method === 'HEAD' && uploadName) {
			return new Response(null, { status: existing.includes(uploadName) ? 200 : 404 });
		} else if (method === 'DELETE' && uploadName) {
			return jsonResponse({});
		} else if (method === 'GET' && uploadName) {
			const dataImport = state.imports.at(-1);
			return jsonResponse({
				kind: 'upload',
				name: dataImport?.name ?? decodeURIComponent(uploadName),
				uri: path,
				status: dataImport?.status ?? 'completed',
			});
		} else if (method === 'POST' && path === `${TABLE}/uploads`) {
			return jsonResponse({ ...body, uri: `${TABLE}/uploads/${body.name}`, status: 'completed' });
		} else if (method === 'POST' && path.endsWith('/rows')) {
			return jsonResponse({ insertedRows: body.rows.length });
		} else if (method === 'POST' && path === `${TABLE}/imports`) {
			const dataImport = { id: `imp${state.imports.length}`, status: 'queued', ...body };
			state.imports.push(dataImport);
			return jsonResponse(importResponse(dataImport));
		}

		const importMatch = path.match(/^\/imports\/([^/]+)(\/.*)?$/);
		if (!importMatch) {
			throw new Error(`Unexpected request: ${method} ${url}`);
		}
		const dataImport = state.imports.find(({ id }) => id === importMatch[1]);
		const rest = importMatch[2] ?? '';
		const fileMatch = rest.match(/^\/files\/([^/]+)(\/uploadSession)?$/);

		if (method === 'GET' && !rest) {
			// A finalized import, or a transfer (which needs no finalizing), is processed
			if (dataImport.status === 'running' || (dataImport.status === 'queued' && dataImport.sourceType)) {
				dataImport.status = statuses[Math.min(state.polls++, statuses.length - 1)];
			}
			return jsonResponse(importResponse(dataImport));
		} else if (method === 'POST' && rest === '/finalize') {
			if (dataImport.status === 'queued') {
				dataImport.status = 'running';
			}
			return jsonResponse(importResponse(dataImport));
		} else if (method === 'POST' && fileMatch && !fileMatch[2]) {
			const bytes = await toBytes(rawBody);
			assert.equal(headers['Content-Type'], 'application/octet-stream');
			if (headers['Content-MD5'] !== md5(bytes)) {
				return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
			}
			state.files[decodeName(fileMatch[1])] = bytes;
			return new Response(null, { status: 200 });
		} else if (method === 'POST' && fileMatch) {
			// The same file again gets its live session back, and otherwise a new one, unless the import has ended
			const name = decodeName(fileMatch[1]);
			const sessionIds = Object.keys(state.sessions).filter((id) => state.sessions[id].name === name);
			const liveId = sessionIds.find((id) => {
				const session = state.sessions[id];
				return !session.dead && session.size === body.size && session.md5 === body.md5Hash;
			});
			const id =
				liveId ??
				(dataImport.status === 'queued' ? `s${Object.keys(state.sessions).length}` : sessionIds.at(-1));
			state.sessions[id] ??= {
				name,
				size: body.size,
				md5: body.md5Hash,
				received: new Uint8Array(body.size),
				committed: 0,
			};
			return jsonResponse({
				kind: 'importUploadSession',
				name,
				size: body.size,
				uri: `/imports/${dataImport.id}/files/${fileMatch[1]}/uploadSession?upload_id=${id}`,
			});
		} else if (method === 'PUT' && fileMatch?.[2]) {
			const session = state.sessions[url.searchParams.get('upload_id')];
			if (session.dead) {
				return new Response('Not found', { status: 404 });
			}
			const range = headers['Content-Range'];
			const chunk = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
			if (chunk) {
				const [, start, end] = chunk.map(Number);
				const bytes = await toBytes(rawBody);
				assert.equal(bytes.length, end - start + 1);
				assert.ok(start <= session.committed, 'A chunk starts after the bytes committed so far');
				session.received.set(bytes, start);
				session.committed = Math.max(session.committed, end + 1);
			} else {
				assert.equal(range, `bytes */${session.size}`);
			}
			if (session.committed === session.size) {
				if (session.md5 && md5(session.received) !== session.md5) {
					session.dead = true;
					return new Response('Bad digest', { status: 400 });
				}
				state.files[session.name] = session.received;
				return new Response(null, { status: 200 });
			}
			return new Response(null, {
				status: 308,
				headers: session.committed ? { range: `bytes=0-${session.committed - 1}` } : {},
			});
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});
	return { requests, state };
}

const isSessionPut = ({ method, url }) => method === 'PUT' && url.pathname.endsWith('/uploadSession');
const describeRequest = ({ method, path }) =>
	`${method} ${path.replace(/\/files\/([^/]+)/, (_, encoded) => `/files/<${decodeName(encoded)}>`)}`;
// The requests made to the API itself, i.e. all but those to upload sessions
const apiRequests = (requests) => requests.filter((request) => !isSessionPut(request)).map(describeRequest);
const sessionRequests = (requests) =>
	requests.filter(({ method, path }) => method === 'POST' && path.endsWith('/uploadSession'));
const sessionPuts = (requests) => requests.filter(isSessionPut).map(({ headers }) => headers['Content-Range']);

test('uploads content to an import, then finalizes it and waits for it', async () => {
	const { requests, state } = mockImports({ statuses: ['running', 'completed'] });
	const progress = [];
	const file = new File(['a,b\n1,2\n'], 'data.csv');
	const upload = await table()
		.upload()
		.create(file, { delimiter: ',', onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded) });

	assert.equal(upload.name, 'data.csv');
	assert.equal(upload.uri, `${TABLE}/uploads/data_csv`);
	assert.equal(upload.getProperty('status'), 'completed');
	assert.deepEqual(apiRequests(requests), [
		`HEAD ${TABLE}/uploads/data_csv`,
		`POST ${TABLE}/imports`,
		`POST /imports/imp0/files/<data.csv>`,
		`POST /imports/imp0/finalize`,
		`GET /imports/imp0`,
		`GET /imports/imp0`,
		`GET ${TABLE}/uploads/data_csv`,
	]);

	const { idempotencyKey, ...payload } = requests[1].body;
	assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
	assert.deepEqual(payload, {
		name: 'data.csv',
		delimiter: ',',
		hasHeaderRow: true,
		skipBadRecords: false,
		allowJaggedRows: false,
		totalFileCount: 1,
		totalSize: 8,
	});

	const post = requests[2];
	assert.equal(post.headers.Authorization, 'Bearer test-token');
	assert.equal(post.headers['Content-MD5'], md5(Buffer.from('a,b\n1,2\n')));
	assert.equal(await toText(state.files['data.csv']), 'a,b\n1,2\n');
	assert.deepEqual(progress, [0, 8]);
});

test('takes the name the import was given, e.g. when renamed on a conflict', async () => {
	const { requests } = mockImports({
		existing: ['data_csv'],
		onRequest: ({ method, path, body }, state) => {
			if (method === 'POST' && path === `${TABLE}/imports`) {
				state.imports.push({ id: 'imp0', status: 'queued', ...body, name: 'data (1).csv' });
				return jsonResponse({ kind: 'import', id: 'imp0', uri: '/imports/imp0', name: 'data (1).csv' });
			}
		},
	});
	const upload = await table()
		.upload('data.csv')
		.create(new Blob(['x']), { renameOnConflict: true, waitForFinish: false });
	const uri = `${TABLE}/uploads/${encodeURIComponent('data (1)_csv')}`;
	assert.equal(upload.name, 'data (1).csv');
	assert.equal(upload.uri, uri);
	// The file is named by the import, since the content has no name of its own
	assert.ok(apiRequests(requests).includes('POST /imports/imp0/files/<data (1).csv>'));
	assert.equal(apiRequests(requests).at(-1), `GET ${uri}`);
});

test('handles name conflicts before creating an import', async () => {
	let { requests } = mockImports({ existing: ['data_csv'] });
	await assert.rejects(
		table()
			.upload('data.csv')
			.create(new Blob(['x'])),
		/already exists/,
	);
	assert.deepEqual(apiRequests(requests), [`HEAD ${TABLE}/uploads/data_csv`]);

	({ requests } = mockImports({ existing: ['data_csv'] }));
	await table()
		.upload('data.csv')
		.create(new Blob(['x']), { replaceOnConflict: true, waitForFinish: false });
	assert.deepEqual(apiRequests(requests).slice(0, 3), [
		`HEAD ${TABLE}/uploads/data_csv`,
		`DELETE ${TABLE}/uploads/data_csv`,
		`POST ${TABLE}/imports`,
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
	const { requests, state } = mockImports();
	await table()
		.upload('rows')
		.create([
			{ id: 9007199254740993n, when: Temporal.PlainDate.from('2020-01-02'), at: new Date(0), name: 'a' },
			{ id: 1n, name: null },
		]);
	assert.equal(requests[1].body.type, 'jsonl');
	assert.equal(
		await toText(state.files.rows),
		'{"id":9007199254740993,"when":"2020-01-02","at":"1970-01-01T00:00:00.000Z","name":"a"}\n{"id":1,"name":null}',
	);

	const { state: arrowState } = mockImports();
	await table()
		.upload('arrow')
		.create(tableFromArrays({ a: [1n, 2n], b: ['x', 'y'] }));
	assert.equal(await toText(arrowState.files.arrow), '{"a":1,"b":"x"}\n{"a":2,"b":"y"}');

	// Without any name, the file is named for its type
	const { requests: unnamedRequests } = mockImports({
		onRequest: ({ method, path, body }, state) => {
			if (method === 'POST' && path === `${TABLE}/imports`) {
				assert.equal(body.name, undefined);
				state.imports.push({ id: 'imp0', status: 'queued', ...body });
				return jsonResponse({ kind: 'import', id: 'imp0', uri: '/imports/imp0', status: 'queued' });
			} else if (path === `${TABLE}/uploads/`) {
				return jsonResponse({ kind: 'upload', name: 'data.jsonl', status: 'queued' });
			}
		},
	});
	await table()
		.upload()
		.create([{ a: 1 }], { waitForFinish: false });
	assert.ok(apiRequests(unnamedRequests).includes('POST /imports/imp0/files/<data.jsonl>'));

	await assert.rejects(table().upload('bad').create([1, 2]), /Each row must be an object/);
	await assert.rejects(table().upload('bad').create({ not: 'content' }), /Unknown option "not"/);
});

test('a retried create sends the same idempotency key', async () => {
	let attempts = 0;
	const { requests } = mockImports({
		onRequest: ({ method, path }) => {
			if (method === 'POST' && path === `${TABLE}/imports` && ++attempts <= 2) {
				if (attempts === 1) throw new TypeError('fetch failed');
				return jsonResponse({ error: 'unavailable' }, { status: 503, headers: { 'retry-after': '0' } });
			}
		},
	});
	await table()
		.upload('x.csv')
		.create(new Blob(['x']));
	const creates = requests.filter(({ method, path }) => method === 'POST' && path === `${TABLE}/imports`);
	assert.equal(creates.length, 3);
	assert.ok(creates[0].body.idempotencyKey);
	assert.equal(new Set(creates.map(({ body }) => body.idempotencyKey)).size, 1);
});

test('a direct upload is retried on transient errors, resending its body', async () => {
	let attempts = 0;
	const { state } = mockImports({
		onRequest: ({ method, path }) => {
			if (method === 'POST' && path.startsWith('/imports/imp0/files/') && ++attempts <= 2) {
				if (attempts === 1) throw new TypeError('fetch failed');
				return jsonResponse({ error: 'bad_gateway' }, { status: 502 });
			}
		},
	});
	await table()
		.upload('x.csv')
		.create(new Blob(['hello']));
	assert.equal(attempts, 3);
	assert.equal(await toText(state.files['x.csv']), 'hello');
});

test("a direct upload whose MD5 doesn't match fails", async () => {
	mockImports({
		onRequest: (request) => {
			if (request.method === 'POST' && request.path.startsWith('/imports/imp0/files/')) {
				request.headers['Content-MD5'] = md5(Buffer.from('other'));
			}
		},
	});
	await assert.rejects(
		table()
			.upload('x.csv')
			.create(new Blob(['hello'])),
		(e) => e.status === 400 && /BadDigest/.test(e.message),
	);
});

test('imports data from another source, passing its identity', async () => {
	const { requests } = mockImports();
	const upload = await table()
		.upload('remote.csv')
		.create({
			transferSpecification: { sourceType: 'gcs', sourcePath: 'bucket/remote.csv', identity: 'me@example.com' },
		});
	assert.equal(upload.getProperty('status'), 'completed');
	const { idempotencyKey, ...payload } = requests[1].body;
	assert.ok(idempotencyKey);
	assert.deepEqual(payload, {
		name: 'remote.csv',
		sourceType: 'gcs',
		sourcePaths: ['bucket/remote.csv'],
		identity: 'me@example.com',
		hasHeaderRow: true,
		skipBadRecords: false,
		allowJaggedRows: false,
	});
	// Nothing is uploaded or finalized: the import transfers the data itself
	assert.deepEqual(apiRequests(requests), [
		`HEAD ${TABLE}/uploads/remote_csv`,
		`POST ${TABLE}/imports`,
		`GET /imports/imp0`,
		`GET ${TABLE}/uploads/remote_csv`,
	]);

	const { requests: urlRequests } = mockImports();
	await table()
		.upload('page.csv')
		.create({ transferSpecification: { sourceType: 'url', sourcePath: 'https://example.com/page.csv' } });
	assert.equal('identity' in urlRequests[1].body, false);
});

test('large files are uploaded in chunks through an upload session, which never receives credentials', async () => {
	const size = 100 * KiB + 7;
	const data = new Uint8Array(size).map((_, i) => i % 251);
	const progress = [];
	const { requests, state } = mockImports();
	await table()
		.upload('big.bin')
		.create(new Blob([data]), {
			type: 'parquet',
			onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded),
		});

	assert.deepEqual(state.files['big.bin'], data);
	assert.deepEqual(sessionRequests(requests)[0].body, { size, md5Hash: md5(data) });
	assert.deepEqual(sessionPuts(requests), [
		`bytes */${size}`,
		`bytes 0-${32 * KiB - 1}/${size}`,
		`bytes ${32 * KiB}-${64 * KiB - 1}/${size}`,
		`bytes ${64 * KiB}-${96 * KiB - 1}/${size}`,
		`bytes ${96 * KiB}-${size - 1}/${size}`,
	]);
	for (const put of requests.filter(isSessionPut)) {
		assert.ok(put.url.href.startsWith(`${API_ROOT}/imports/imp0/files/`));
		assert.equal(put.headers.Authorization, undefined);
		assert.equal(put.headers.DPoP, undefined);
	}
	assert.deepEqual(progress, [0, 32 * KiB, 64 * KiB, 96 * KiB, size]);
});

test('a session continues from what it committed after an interruption', async () => {
	const size = 80 * KiB;
	const data = new Uint8Array(size).map((_, i) => i % 251);
	// Stream the data in pieces, so that a range must be re-read from the stream's buffer after the interruption
	const stream = new ReadableStream({
		start(controller) {
			for (let i = 0; i < size; i += 10 * KiB) controller.enqueue(data.slice(i, i + 10 * KiB));
			controller.close();
		},
	});
	let failedOnce = false;
	const { requests, state } = mockImports({
		onRequest: ({ method, headers }) => {
			if (
				method === 'PUT' &&
				headers['Content-Range'] === `bytes ${32 * KiB}-${64 * KiB - 1}/${size}` &&
				!failedOnce
			) {
				failedOnce = true;
				throw new TypeError('fetch failed');
			}
		},
	});
	await table().upload('stream.bin').create(stream, { size, waitForFinish: false });

	assert.deepEqual(state.files['stream.bin'], data);
	// A large stream can't be hashed before it's uploaded, since it can only be read once
	assert.deepEqual(sessionRequests(requests)[0].body, { size });
	assert.deepEqual(sessionPuts(requests), [
		`bytes */${size}`,
		`bytes 0-${32 * KiB - 1}/${size}`,
		`bytes ${32 * KiB}-${64 * KiB - 1}/${size}`,
		`bytes */${size}`,
		// The chunk size halves after a failure, then grows again
		`bytes ${32 * KiB}-${48 * KiB - 1}/${size}`,
		`bytes ${48 * KiB}-${80 * KiB - 1}/${size}`,
	]);
});

test('a session that already has part of the file resumes from there', async () => {
	const size = 70 * KiB;
	const data = new Uint8Array(size).map((_, i) => i % 13);
	const progress = [];
	const { requests, state } = mockImports({
		onRequest: ({ method, path, body }, state) => {
			// A session left by an earlier attempt, which has the first 16KiB
			if (method === 'POST' && path.endsWith('/uploadSession') && !state.sessions.s0) {
				const received = new Uint8Array(size);
				received.set(data.subarray(0, 16 * KiB));
				state.sessions.s0 = { name: 'f.bin', size, md5: body.md5Hash, received, committed: 16 * KiB };
			}
		},
	});
	await table()
		.upload('f.bin')
		.create(new Blob([data]), {
			waitForFinish: false,
			onProgress: ({ bytesUploaded }) => progress.push(bytesUploaded),
		});
	assert.deepEqual(state.files['f.bin'], data);
	assert.deepEqual(sessionPuts(requests), [
		`bytes */${size}`,
		`bytes ${16 * KiB}-${48 * KiB - 1}/${size}`,
		`bytes ${48 * KiB}-${size - 1}/${size}`,
	]);
	assert.deepEqual(progress, [0, 16 * KiB, 48 * KiB, size]);
});

test('a dead session is replaced, and the file uploaded to the new one', async () => {
	const size = 70 * KiB;
	const data = new Uint8Array(size).map((_, i) => i % 7);
	let killed = false;
	const { requests, state } = mockImports({
		onRequest: ({ method, headers, url }, state) => {
			if (method === 'PUT' && !killed && headers['Content-Range'].startsWith(`bytes ${32 * KiB}-`)) {
				killed = true;
				state.sessions[url.searchParams.get('upload_id')].dead = true;
			}
		},
	});
	await table()
		.upload('f.bin')
		.create(new Blob([data]), { waitForFinish: false });
	assert.deepEqual(state.files['f.bin'], data);
	assert.equal(sessionRequests(requests).length, 2);
	assert.deepEqual(
		requests
			.filter(isSessionPut)
			.map(({ url, headers }) => `${url.searchParams.get('upload_id')} ${headers['Content-Range']}`),
		[
			`s0 bytes */${size}`,
			`s0 bytes 0-${32 * KiB - 1}/${size}`,
			`s0 bytes ${32 * KiB}-${64 * KiB - 1}/${size}`,
			`s1 bytes */${size}`,
			`s1 bytes 0-${32 * KiB - 1}/${size}`,
			`s1 bytes ${32 * KiB}-${64 * KiB - 1}/${size}`,
			`s1 bytes ${64 * KiB}-${size - 1}/${size}`,
		],
	);
});

test("a dead session that can't be replaced fails the upload", async () => {
	const { requests } = mockImports({
		onRequest: ({ method, url }, state) => {
			if (method === 'PUT' && url.searchParams.get('upload_id') === 's0') {
				state.sessions.s0.dead = true;
				// The import has expired, so the same (dead) session is all that the API returns
				state.imports[0].status = 'failed';
			}
		},
	});
	await assert.rejects(
		table()
			.upload('f.bin')
			.create(new Blob([new Uint8Array(70 * KiB)]), { waitForFinish: false }),
		(e) => e.status === 404 && /can no longer accept files/.test(e.message),
	);
	assert.equal(sessionRequests(requests).length, 2);
});

test('a file that keeps failing its MD5 check on completion fails the upload after a few sessions', async () => {
	const { requests, state } = mockImports({
		onRequest: (request) => {
			if (request.method === 'POST' && request.path.endsWith('/uploadSession')) {
				request.body.md5Hash = md5(Buffer.from('other'));
			}
		},
	});
	await assert.rejects(
		table()
			.upload('f.bin')
			.create(new Blob([new Uint8Array(70 * KiB)]), { waitForFinish: false }),
		(e) => e.status === 400 && /failed on 4 upload sessions/.test(e.message),
	);
	assert.equal(sessionRequests(requests).length, 5);
	assert.equal(state.files['f.bin'], undefined);
});

test('a session gives up after too many failures without progress', async () => {
	mockImports({
		onRequest: ({ method, url }) => {
			if (method === 'PUT' && url.pathname.endsWith('/uploadSession')) {
				return new Response('unavailable', { status: 503 });
			}
		},
	});
	await assert.rejects(
		table()
			.upload('f.bin')
			.create(new Blob([new Uint8Array(70 * KiB)]), { waitForFinish: false }),
		NetworkError,
	);
});

test('a ReadableStream requires a size', async () => {
	mockImports();
	await assert.rejects(table().upload('x').create(new ReadableStream()), /size of a ReadableStream must be provided/);
});

test('failed imports throw a JobError, and can be removed', async () => {
	const { requests } = mockImports({ statuses: ['running', 'failed'], errorMessage: 'Bad CSV' });
	await assert.rejects(
		table()
			.upload('x')
			.create(new Blob(['x']), { type: 'delimited', removeOnFail: true }),
		(e) => e instanceof JobError && e.status === 'failed' && /Bad CSV/.test(e.message),
	);
	assert.equal(apiRequests(requests).at(-1), `DELETE ${TABLE}/uploads/x`);

	mockImports({ statuses: ['cancelled'] });
	const upload = await table()
		.upload('y')
		.create(new Blob(['x']), { type: 'delimited', raiseOnFail: false });
	assert.equal(upload.getProperty('status'), 'cancelled');
});

test('stream uploads are created directly, and rows inserted into them', async () => {
	const { requests } = mockImports();
	const upload = await table()
		.upload('stream')
		.create({ type: 'stream', schema: [{ name: 'id', type: 'integer' }] });
	assert.deepEqual(apiRequests(requests), [`HEAD ${TABLE}/uploads/stream`, `POST ${TABLE}/uploads`]);
	assert.deepEqual(requests[1].body.schema, [{ name: 'id', type: 'integer' }]);

	await upload.insertRows([{ id: 9007199254740993n, day: Temporal.PlainDate.from('2020-01-02') }]);
	assert.equal(requests.at(-1).rawBody, '{"rows":[{"id":9007199254740993,"day":"2020-01-02"}]}');
	await assert.rejects(new Upload('stream', { table: table() }).insertRows({ id: 1 }), ValueError);
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

test('adds files to a file index table through a single import', async () => {
	const big = new Uint8Array(100 * KiB).map((_, i) => i % 17);
	const { requests, state } = mockImports({ statuses: ['running', 'completed'] });
	const progress = [];
	await table().addFiles({
		files: [
			{ name: 'a.txt', data: 'hello' },
			new File(['world!'], 'b.txt'),
			{ name: 'c.bin', data: new Uint8Array(3) },
			{ name: 'dir/big.bin', data: big },
		],
		maxParallelization: 2,
		onProgress: (p) => progress.push(p),
	});

	const described = apiRequests(requests);
	assert.equal(described.filter((request) => request === `POST ${TABLE}/imports`).length, 1);
	assert.equal(described.filter((request) => request === 'POST /imports/imp0/finalize').length, 1);
	assert.deepEqual(described.filter((request) => request.startsWith('POST /imports/imp0/files/')).sort(), [
		'POST /imports/imp0/files/<a.txt>',
		'POST /imports/imp0/files/<b.txt>',
		'POST /imports/imp0/files/<c.bin>',
		'POST /imports/imp0/files/<dir/big.bin>/uploadSession',
	]);
	assert.equal(described.at(-1), 'GET /imports/imp0');

	const { idempotencyKey, ...payload } = requests[0].body;
	assert.ok(idempotencyKey);
	assert.deepEqual(payload, { totalFileCount: 4, totalSize: 14 + big.length });

	assert.equal(await toText(state.files['a.txt']), 'hello');
	assert.equal(await toText(state.files['b.txt']), 'world!');
	assert.deepEqual(state.files['c.bin'], new Uint8Array(3));
	assert.deepEqual(state.files['dir/big.bin'], big);
	assert.deepEqual(progress.at(-1), {
		bytesUploaded: 14 + big.length,
		totalBytes: 14 + big.length,
		filesUploaded: 4,
		totalFiles: 4,
	});

	await assert.rejects(table().addFiles({ files: [{ data: 'x' }] }), /must also have a `name`/);
	await assert.rejects(table().addFiles({}), /Exactly one of `files` or `directory`/);
});

test('adding files throws if the import fails', async () => {
	mockImports({ statuses: ['failed'], errorMessage: 'Too many files' });
	await assert.rejects(table().addFiles({ files: [{ name: 'a.txt', data: 'a' }] }), (e) => {
		assert.ok(e instanceof JobError);
		assert.match(e.message, /Too many files/);
		return true;
	});
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

		const { state } = mockImports();
		await table().addFiles({ directory });
		assert.deepEqual(Object.keys(state.files).sort(), ['a.csv', 'nested/b.csv']);
		assert.equal(await toText(state.files['nested/b.csv']), 'bb');
	} finally {
		await rm(directory, { recursive: true });
	}
});

test('file names are encoded as unpadded base64url', () => {
	for (const name of ['a', 'ab', 'données/été.csv', '数据 ~?.txt', '🙂', 'a+b/c?d>']) {
		assert.equal(encodeImportFileName(name), Buffer.from(name).toString('base64url'));
		assert.doesNotMatch(encodeImportFileName(name), /[=+/]/);
	}
	assert.equal(encodeImportFileName('données.csv'), 'ZG9ubsOpZXMuY3N2');
});

test("the browser's MD5 matches Node's", () => {
	for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003]) {
		const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) % 256);
		const hash = new Md5();
		// In uneven pieces, to exercise the buffering of partial blocks
		for (let offset = 0; offset < size;) {
			const length = Math.min(size - offset, 1 + ((offset * 13) % 97));
			hash.update(data.subarray(offset, offset + length));
			offset += length;
		}
		assert.equal(bytesToBase64(hash.digest()), md5(data), `size ${size}`);
	}
});
