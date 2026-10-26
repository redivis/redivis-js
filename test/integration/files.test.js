// Raw files in file index tables: uploading, listing, reading, and downloading them.
import { createTable, sample, skip } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import redivis from '../../index.js';
import Directory from '../../src/classes/Directory.js';
import File from '../../src/classes/File.js';
import { md5Base64, rawFiles } from './data.js';

const { NotFoundError, ValueError } = redivis.errors;
const FILES = rawFiles();
const RANDOM = FILES['data/nested/random.bin'];

async function tempDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), 'redivis-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

// The contents of every file under a directory, by their relative path
async function readTree(directory) {
	const entries = await readdir(directory, { recursive: true, withFileTypes: true });
	const files = {};
	for (const entry of entries.filter((entry) => entry.isFile())) {
		const path = join(entry.parentPath, entry.name);
		files[relative(directory, path).split('\\').join('/')] = new Uint8Array(await readFile(path));
	}
	return files;
}

// Reads a stream to the end, returning its chunks
async function readChunks(stream) {
	const chunks = [];
	for await (const chunk of stream) {
		chunks.push(chunk);
	}
	return chunks;
}

const concat = (chunks) => new Uint8Array(Buffer.concat(chunks));

describe('files', { skip }, () => {
	test('list files, with their sizes and hashes', async () => {
		const files = await (await sample.files()).listFiles();

		assert.ok(files.every((file) => file instanceof File));
		assert.deepEqual(
			Object.fromEntries(files.map((file) => [file.path, file.size])),
			Object.fromEntries(Object.entries(FILES).map(([path, content]) => [path, content.length])),
		);
		for (const file of files) {
			assert.equal(file.md5Hash, md5Base64(FILES[file.path]), file.path);
			assert.equal(file.name, file.path.split('/').pop());
		}
	});

	test('list files, up to maxResults', async () => {
		const table = await sample.files();

		assert.equal((await table.listFiles(2)).length, 2);
		assert.equal((await table.listFiles({ maxResults: 3 })).length, 3);
	});

	test('the directory structure', async () => {
		const root = await (await sample.files()).toDirectory();

		assert.ok(root instanceof Directory);
		assert.deepEqual(
			root
				.list()
				.map((child) => child.name)
				.sort(),
			['data', 'readme.txt', 'with space & symbols.txt'],
		);
		assert.deepEqual(
			root.list({ mode: 'directories', recursive: true }).map((directory) => directory.path),
			['/data', '/data/nested'],
		);
		const nested = root.get('data/nested');
		assert.ok(nested instanceof Directory);
		assert.deepEqual(
			nested.list().map((file) => file.name),
			['random.bin'],
		);
		assert.equal(nested.get('../numbers.csv').name, 'numbers.csv');
		assert.equal(nested.get('/readme.txt').path, 'readme.txt');
		assert.equal(root.get('data/missing.txt'), null);
		assert.equal(root.get('readme.txt/'), null);
	});

	test('an unchanged listing is reused', async () => {
		const table = await sample.files();

		const first = await table.toDirectory();
		const second = await table.toDirectory();

		assert.equal(second, first);
	});

	for (const path of Object.keys(FILES).sort()) {
		test(`read ${path}`, async () => {
			const file = await (await sample.files()).file(path);

			assert.deepEqual(await file.read(), FILES[path]);
		});
	}

	test('read as text', async () => {
		const file = await (await sample.files()).file('readme.txt');

		assert.equal(await file.read({ asText: true }), new TextDecoder().decode(FILES['readme.txt']));
	});

	test('read a byte range', async () => {
		const file = await (await sample.files()).file('data/nested/random.bin');

		assert.deepEqual(await file.read({ startByte: 100, endByte: 199 }), RANDOM.subarray(100, 200));
		assert.deepEqual(await file.read({ startByte: RANDOM.length - 10 }), RANDOM.subarray(-10));
		await assert.rejects(file.read({ startByte: 10, endByte: 5 }), ValueError);
	});

	test('stream a file', async () => {
		const file = await (await sample.files()).file('data/nested/random.bin');

		const chunks = await readChunks(file.stream());

		// A 3MB file arrives in several chunks
		assert.ok(chunks.length > 1);
		assert.deepEqual(concat(chunks), RANDOM);
	});

	test('stream a range of a file', async () => {
		const file = await (await sample.files()).file('data/nested/random.bin');
		const start = 2 ** 20;

		const chunks = await readChunks(file.stream({ startByte: start, endByte: start + 2 ** 20 - 1 }));

		assert.deepEqual(concat(chunks), RANDOM.subarray(start, start + 2 ** 20));
	});

	test('a missing file, or a directory, is not a file', async () => {
		const table = await sample.files();

		await assert.rejects(table.file('missing.txt'), NotFoundError);
		await assert.rejects(table.file('data'), { name: 'ValueError', message: /is a directory/ });
	});

	test('download a file', async (t) => {
		const directory = await tempDirectory(t);
		const file = await (await sample.files()).file('data/nested/random.bin');

		assert.equal(await file.download(`${directory}/`), join(directory, 'random.bin'));
		assert.deepEqual(new Uint8Array(await readFile(join(directory, 'random.bin'))), RANDOM);

		const target = join(directory, 'renamed.bin');
		const progress = [];
		assert.equal(await file.download(target, { onProgress: (p) => progress.push(p) }), target);
		assert.deepEqual(new Uint8Array(await readFile(target)), RANDOM);
		assert.deepEqual(progress.at(-1), { bytesDownloaded: RANDOM.length, totalBytes: RANDOM.length });
	});

	test('downloading over a file leaves an identical one, and refuses to replace a different one', async (t) => {
		const directory = await tempDirectory(t);
		const file = await (await sample.files()).file('readme.txt');
		const path = join(directory, 'readme.txt');

		await file.download(path);
		// Identical, so there's nothing to do
		await file.download(path);

		await writeFile(path, 'something else');
		await assert.rejects(file.download(path), ValueError);
		await file.download(path, { overwrite: true });
		assert.deepEqual(new Uint8Array(await readFile(path)), FILES['readme.txt']);
	});

	test('download a directory', async (t) => {
		const directory = await tempDirectory(t);
		const progress = [];

		const paths = await (
			await sample.files()
		)
			.toDirectory()
			.then((root) => root.download(directory, { onProgress: (p) => progress.push(p) }));

		assert.equal(paths.length, Object.keys(FILES).length);
		assert.deepEqual(await readTree(directory), FILES);
		assert.equal(progress.at(-1).filesDownloaded, Object.keys(FILES).length);
	});

	test('download a subdirectory', async (t) => {
		const directory = await tempDirectory(t);

		await (await (await sample.files()).toDirectory()).get('data').download(directory);

		assert.deepEqual(Object.keys(await readTree(directory)).sort(), ['nested/random.bin', 'numbers.csv']);
	});

	test('the files of a query', async () => {
		const files = await sample.files();
		const query = redivis.query(`SELECT * FROM \`${files.qualifiedReference}\` WHERE file_name LIKE 'data/%'`);

		const listed = await query.listFiles();

		assert.deepEqual(listed.map((file) => file.path).sort(), ['data/nested/random.bin', 'data/numbers.csv']);
		assert.deepEqual(await (await query.file('data/numbers.csv')).read(), FILES['data/numbers.csv']);
	});

	test('add files from memory', async (t) => {
		const table = await createTable(t, { isFileIndex: true });

		await table.addFiles({
			files: [
				{ name: 'a.txt', data: 'text content' },
				{ name: 'dir/b.bin', data: new Uint8Array([0, 1, 2]) },
				new globalThis.File(['from a File'], 'c.txt'),
				{ name: 'd.txt', data: new Blob(['from a Blob']) },
			],
		});

		assert.equal(await (await table.file('a.txt')).read({ asText: true }), 'text content');
		assert.deepEqual(await (await table.file('dir/b.bin')).read(), new Uint8Array([0, 1, 2]));
		assert.equal(await (await table.file('c.txt')).read({ asText: true }), 'from a File');
		assert.equal(await (await table.file('d.txt')).read({ asText: true }), 'from a Blob');
	});

	test('add files from paths', async (t) => {
		const table = await createTable(t, { isFileIndex: true });
		const path = join(await tempDirectory(t), 'local.txt');
		await writeFile(path, 'from disk');
		const progress = [];

		await table.addFiles({
			files: [path, { path, name: 'copy.txt' }],
			onProgress: (p) => progress.push(p),
		});

		assert.deepEqual((await table.listFiles()).map((file) => file.path).sort(), ['copy.txt', 'local.txt']);
		assert.equal((await table.get()).properties.numRows, 2);
		assert.deepEqual(progress.at(-1), { bytesUploaded: 18, totalBytes: 18, filesUploaded: 2, totalFiles: 2 });
	});

	test('add a directory of files, skipping hidden ones', async (t) => {
		const table = await createTable(t, { isFileIndex: true });
		const directory = await tempDirectory(t);
		await writeFile(join(directory, 'visible.txt'), 'visible');
		await writeFile(join(directory, '.hidden'), 'hidden');

		await table.addFiles({ directory });

		assert.deepEqual(
			(await table.listFiles()).map((file) => file.path),
			['visible.txt'],
		);
	});

	test('addFiles() requires files or a directory', async (t) => {
		const table = await createTable(t, { isFileIndex: true });

		await assert.rejects(table.addFiles(), ValueError);
		await assert.rejects(table.addFiles({ files: [{ data: 'no name' }] }), ValueError);
	});
});
