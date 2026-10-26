import { arrowResponse, jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays, vectorFromArray, Utf8 } from 'apache-arrow';
import redivis from '../../index.js';
import Directory from '../../src/classes/Directory.js';
import File from '../../src/classes/File.js';
import { NotFoundError, ValueError } from '../../src/common/errors.js';

const md5 = (data) => createHash('md5').update(data).digest('base64');
const strings = (values) => vectorFromArray(values, new Utf8());

const contents = {
	f1: 'readme contents',
	f2: 'a'.repeat(100),
	f3: 'nested deeper',
};
const listing = tableFromArrays({
	file_id: strings(['f1', 'f2', 'f3']),
	file_name: strings(['README.md', 'images/a.png', 'images/deep/b.txt']),
	size: BigInt64Array.from(Object.values(contents), (c) => BigInt(c.length)),
	md5_hash: strings(Object.values(contents).map(md5)),
}).batches[0];

// Serves the file listing and the files' contents. `fileResponse(request, id)` can override a file's response.
function mockFiles({ fileResponse, lastModified = 'Wed, 01 Jan 2025 00:00:00 GMT' } = {}) {
	return mockFetch(async (request) => {
		const { path, headers } = request;
		if (path.endsWith('/rawFiles')) {
			if (headers['If-Modified-Since'] === lastModified) {
				return new Response(null, { status: 304 });
			}
			const response = await arrowResponse([listing]);
			response.headers.set('last-modified', lastModified);
			return response;
		}
		const id = decodeURIComponent(path.split('/rawFiles/')[1]);
		return fileResponse?.(request, id) ?? rangeResponse(contents[id], headers.Range);
	});
}

function rangeResponse(content, range) {
	const match = range?.match(/bytes=(\d+)-(\d*)/);
	if (!match) {
		return new Response(content, { headers: { 'content-length': String(content.length) } });
	}
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : content.length - 1;
	return new Response(content.slice(start, end + 1), {
		status: 206,
		headers: { 'content-range': `bytes ${start}-${end}/${content.length}` },
	});
}

// A response whose body fails after sending `prefix`
function interruptedResponse(prefix, init) {
	let sent = false;
	const body = new ReadableStream({
		pull(controller) {
			// NB: erroring a stream discards anything still queued, so the error waits for the next read
			if (sent) {
				controller.error(new TypeError('terminated'));
			} else {
				sent = true;
				controller.enqueue(new TextEncoder().encode(prefix));
			}
		},
	});
	return new Response(body, init);
}

async function withTempDir(fn) {
	const directory = await mkdtemp(join(tmpdir(), 'redivis-js-test-'));
	try {
		return await fn(directory);
	} finally {
		await rm(directory, { recursive: true });
	}
}

let tableCount = 0;
// A fresh table each time, so that listings aren't shared through the cache
const newTable = () => redivis.table(`demo.ds.files_${tableCount++}`);

test('lists files as a directory tree', async () => {
	mockFiles();
	const directory = await newTable().toDirectory();

	assert.ok(directory instanceof Directory);
	assert.deepEqual(directory.list().map(String), ['<File README.md>', '<Directory /images>']);
	assert.deepEqual(directory.list({ recursive: true }).map(String), [
		'<File README.md>',
		'<Directory /images>',
		'<File images/a.png>',
		'<Directory /images/deep>',
		'<File images/deep/b.txt>',
	]);
	assert.deepEqual(
		directory.list({ mode: 'files', recursive: true }).map(({ path }) => path),
		['README.md', 'images/a.png', 'images/deep/b.txt'],
	);
	assert.deepEqual(
		directory.list(2, { mode: 'files', recursive: true }).map(({ path }) => path),
		['README.md', 'images/a.png'],
	);

	const file = directory.get('images/a.png');
	assert.ok(file instanceof File);
	assert.equal(file.name, 'a.png');
	assert.equal(file.size, 100);
	assert.equal(file.md5Hash, md5(contents.f2));
	assert.equal(file.uri, '/rawFiles/f2');

	const images = directory.get('images/');
	assert.equal(images.get('deep/../a.png'), file);
	assert.equal(images.get('/README.md'), directory.get('README.md'));
	assert.equal(images.get('..'), directory);
	assert.equal(directory.get('README.md/'), null);
	assert.equal(directory.get('missing'), null);
	assert.throws(() => directory.get('../x'), ValueError);
});

test('reuses a listing that has not changed', async () => {
	const requests = mockFiles();
	const table = newTable();
	const directory = await table.toDirectory();
	assert.equal(await table.toDirectory(), directory);
	const listings = requests.filter(({ path }) => path.endsWith('/rawFiles'));
	assert.equal(listings[1].headers['If-Modified-Since'], 'Wed, 01 Jan 2025 00:00:00 GMT');

	// file() uses a listing from the last 30 seconds without asking again
	assert.equal((await table.file('images/deep/b.txt')).path, 'images/deep/b.txt');
	assert.equal(requests.filter(({ path }) => path.endsWith('/rawFiles')).length, 2);
	await assert.rejects(table.file('nope'), NotFoundError);
	await assert.rejects(table.file('images'), /is a directory/);

	const files = await table.listFiles(2, { fileNameVariable: 'file_name' });
	assert.equal(files.length, 2);
	assert.equal(
		requests
			.filter(({ path }) => path.endsWith('/rawFiles'))
			.at(-1)
			.url.searchParams.get('fileNameVariable'),
		'file_name',
	);
});

test('reads files, and ranges of them', async () => {
	mockFiles();
	const directory = await newTable().toDirectory();
	const file = directory.get('README.md');
	assert.equal(await file.read({ asText: true }), contents.f1);
	assert.deepEqual(await file.read({ startByte: 7, endByte: 10 }), new TextEncoder().encode('cont'));
	assert.equal(await file.read({ asText: true, startByte: 7 }), 'contents');
	assert.throws(() => file.stream({ startByte: 5, endByte: 2 }), ValueError);
});

test('reads ranges even if the server ignores the range', async () => {
	mockFiles({ fileResponse: (request, id) => new Response(contents[id]) });
	const file = (await newTable().toDirectory()).get('README.md');
	assert.equal(await file.read({ asText: true, startByte: 7, endByte: 10 }), 'cont');
});

test('file streams resume after an interruption', async () => {
	let attempts = 0;
	const requests = mockFiles({
		fileResponse: ({ headers }, id) =>
			++attempts === 1
				? interruptedResponse(contents[id].slice(0, 6))
				: rangeResponse(contents[id], headers.Range),
	});
	const file = (await newTable().toDirectory()).get('README.md');
	assert.equal(await file.read({ asText: true }), contents.f1);
	assert.deepEqual(
		requests.filter(({ path }) => path.startsWith('/rawFiles/')).map(({ headers }) => headers.Range),
		[undefined, 'bytes=6-'],
	);
});

test('downloads files, skipping identical ones and refusing to overwrite others', async () => {
	await withTempDir(async (dir) => {
		const requests = mockFiles();
		const file = (await newTable().toDirectory()).get('images/a.png');
		const progress = [];
		const downloadedPath = await file.download(`${dir}/`, {
			onProgress: ({ bytesDownloaded }) => progress.push(bytesDownloaded),
		});
		assert.equal(downloadedPath, join(dir, 'a.png'));
		assert.equal(await readFile(downloadedPath, 'utf8'), contents.f2);
		assert.equal(progress.at(-1), 100);

		// An identical file isn't downloaded again
		const fileRequests = () => requests.filter(({ path }) => path.startsWith('/rawFiles/')).length;
		await file.download(dir);
		assert.equal(fileRequests(), 1);

		await writeFile(downloadedPath, 'something else');
		await assert.rejects(file.download(dir), /already exists/);
		await file.download(downloadedPath, { overwrite: true });
		assert.equal(await readFile(downloadedPath, 'utf8'), contents.f2);
		assert.deepEqual(await readdir(dir), ['a.png']);
	});
});

test('file downloads resume, or restart if the server can not resume', async () => {
	await withTempDir(async (dir) => {
		const ranges = [];
		let attempts = 0;
		mockFiles({
			fileResponse: ({ headers }, id) => {
				ranges.push(headers.Range);
				attempts++;
				if (attempts === 1) return interruptedResponse(contents[id].slice(0, 40));
				// The server ignores the range the first time, so the download starts over
				if (attempts === 2) return interruptedResponse(contents[id].slice(0, 20));
				return rangeResponse(contents[id], headers.Range);
			},
		});
		const file = (await newTable().toDirectory()).get('images/a.png');
		await file.download(join(dir, 'out.png'));
		assert.equal(await readFile(join(dir, 'out.png'), 'utf8'), contents.f2);
		assert.deepEqual(ranges, [undefined, 'bytes=40-', 'bytes=20-']);
	});
});

test('file downloads are verified against their MD5 hash', async () => {
	await withTempDir(async (dir) => {
		let attempts = 0;
		mockFiles({ fileResponse: () => (attempts++, new Response('x'.repeat(100))) });
		const file = (await newTable().toDirectory()).get('images/a.png');
		await assert.rejects(file.download(dir), /MD5 hash doesn't match/);
		assert.equal(attempts, 2);
		// The partial download is cleaned up
		assert.deepEqual(await readdir(dir), []);
	});
});

test('downloads a directory, recreating its structure', async () => {
	await withTempDir(async (dir) => {
		mockFiles();
		const directory = await newTable().toDirectory();
		const progress = [];
		const paths = await directory.get('images').download(join(dir, 'out'), { onProgress: (p) => progress.push(p) });
		assert.deepEqual(paths, [join(dir, 'out', 'a.png'), join(dir, 'out', 'deep', 'b.txt')]);
		assert.equal(await readFile(join(dir, 'out', 'deep', 'b.txt'), 'utf8'), contents.f3);
		assert.deepEqual(progress.at(-1), { bytesDownloaded: 113, totalBytes: 113, filesDownloaded: 2, totalFiles: 2 });
	});
});

// Mocks an export of the table demo.ds.t, which finishes after one poll, into `parts`
function mockExport(parts, { format = 'csv' } = {}) {
	let polls = 0;
	return mockFetch(({ method, path, url }) => {
		if (path === '/tables/demo.ds.t') {
			return jsonResponse({ name: 'My Table!', uri: '/tables/demo.ds.t', numRows: 1, numBytes: 1 });
		} else if (method === 'POST' && path === '/tables/demo.ds.t/exports') {
			return jsonResponse({ id: 'e1', uri: '/exports/e1', status: 'running', percentCompleted: 0 });
		} else if (path === '/exports/e1') {
			return jsonResponse({
				id: 'e1',
				uri: '/exports/e1',
				status: polls++ ? 'completed' : 'running',
				percentCompleted: polls ? 100 : 50,
				fileCount: parts.length,
				format,
			});
		} else if (path === '/exports/e1/download') {
			const part = parts[Number(url.searchParams.get('filePart'))];
			return new Response(part, { headers: { 'x-goog-hash': `crc32c=abc, md5=${md5(part)}` } });
		}
		throw new Error(`Unexpected request: ${method} ${path}`);
	});
}

test('downloads a single-file export to a file or directory', async () => {
	await withTempDir(async (dir) => {
		const requests = mockExport(['a,b\n1,2\n']);
		const paths = await redivis.table('demo.ds.t').download(dir, { format: 'csv' });
		assert.deepEqual(paths, [join(dir, 'my_table_.csv')]);
		assert.equal(await readFile(paths[0], 'utf8'), 'a,b\n1,2\n');
		assert.deepEqual(requests.find(({ method }) => method === 'POST').body, { format: 'csv' });

		mockExport(['x']);
		assert.deepEqual(await redivis.table('demo.ds.t').download(join(dir, 'custom.csv')), [join(dir, 'custom.csv')]);
	});
});

test('downloads a multi-part export into its own directory', async () => {
	await withTempDir(async (dir) => {
		mockExport(['part 0', 'part 1'], { format: 'parquet' });
		const stages = new Set();
		const paths = await redivis.table('demo.ds.t').download(dir, {
			format: 'parquet',
			onProgress: ({ stage }) => stages.add(stage),
		});
		assert.deepEqual(paths, [join(dir, 'my_table_', '000000.parquet'), join(dir, 'my_table_', '000001.parquet')]);
		assert.equal(await readFile(paths[1], 'utf8'), 'part 1');
		assert.deepEqual([...stages], ['exporting', 'downloading']);

		mockExport(['part 0', 'part 1']);
		await writeFile(join(dir, 'existing.csv'), 'x');
		await assert.rejects(redivis.table('demo.ds.t').download(join(dir, 'existing.csv')), /consists of 2 files/);
	});
});

test('rejects listing files where it is not supported', async () => {
	mockFetch(() => jsonResponse({ results: [] }));
	await assert.rejects(redivis.table('demo.ds.t').upload('x').toDirectory(), /only supported for tables and queries/);
	assert.throws(() => new File('id', 'name', {}), ValueError);
});
