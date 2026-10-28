// Uploading data to tables, in each of the forms that upload.create() accepts.
import { createDataset, createTable, sample, skip, settings } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tableFromArrays } from 'apache-arrow';
import { Temporal } from 'temporal-polyfill';
import redivis from '../../index.js';
import { SMALL_CSV, TINY_CSV, largeCsv, sortedBy, tinyRows } from './data.js';
import { column, readSorted } from './helpers.js';

const { JobError, ValueError } = redivis.errors;
const encode = (text) => new TextEncoder().encode(text);
const JAGGED_CSV = 'a,b\n1,2\n3\n4,5\n';

// What reading SMALL_CSV back should return
const SMALL_ROWS = [
	{ id: 1, name: 'a', value: 1.5 },
	{ id: 2, name: 'b', value: 2.5 },
	{ id: 3, name: 'c', value: null },
];

// Each test creates its own tables, so they can run concurrently
describe('uploads', { skip, concurrency: true }, () => {
	test('a file path names the upload after the file', async (t) => {
		const table = await createTable(t);

		const upload = await table.upload().create(TINY_CSV);

		assert.equal(upload.name, 'tiny.csv');
		assert.equal(upload.properties.status, 'completed');
		assert.equal(upload.properties.numRows, tinyRows().length);
		assert.equal((await table.get()).properties.numRows, tinyRows().length);
		assert.deepEqual(await readSorted(table), tinyRows());
	});

	test('a File, named by its name', async (t) => {
		const table = await createTable(t);

		const upload = await table.upload().create(new File([SMALL_CSV], 'small.csv'));

		assert.equal(upload.name, 'small.csv');
		assert.deepEqual(await readSorted(table), SMALL_ROWS);
	});

	for (const [kind, content] of [
		['a Blob', () => new Blob([SMALL_CSV])],
		['a Uint8Array', () => encode(SMALL_CSV)],
		['an ArrayBuffer', () => encode(SMALL_CSV).buffer],
		['a Buffer', () => Buffer.from(SMALL_CSV)],
	]) {
		test(`${kind}`, async (t) => {
			const table = await createTable(t);

			const upload = await table.upload('small.csv').create(content());

			assert.equal(upload.name, 'small.csv');
			assert.equal(upload.properties.type, 'delimited');
			assert.deepEqual(await readSorted(table), SMALL_ROWS);
		});
	}

	test('a ReadableStream, of a given size', async (t) => {
		const table = await createTable(t);
		const bytes = encode(SMALL_CSV);
		// In several chunks
		const stream = new ReadableStream({
			start(controller) {
				for (let i = 0; i < bytes.length; i += 7) {
					controller.enqueue(bytes.slice(i, i + 7));
				}
				controller.close();
			},
		});

		await table.upload('small.csv').create(stream, { size: bytes.length });

		assert.deepEqual(await readSorted(table), SMALL_ROWS);
	});

	test('an array of rows', async (t) => {
		const table = await createTable(t);
		const rows = [
			{ id: 1, name: 'a', value: 1.5, flag: true, day: Temporal.PlainDate.from('2020-01-01') },
			{ id: 2, name: 'b', value: null, flag: false, day: Temporal.PlainDate.from('2021-06-15') },
			{ id: 3, name: null, value: -3, flag: true, day: null },
		];

		const upload = await table.upload('rows').create(rows);

		assert.equal(upload.properties.type, 'jsonl');
		const actual = await readSorted(table, 'id', { temporal: false });
		assert.deepEqual(column(actual, 'name'), ['a', 'b', null]);
		assert.deepEqual(column(actual, 'value'), [1.5, null, -3]);
		assert.deepEqual(column(actual, 'flag'), [true, false, true]);
		assert.deepEqual(
			column(actual, 'day').map((day) => day?.toISOString().slice(0, 10) ?? null),
			['2020-01-01', '2021-06-15', null],
		);
	});

	test('an arrow Table', async (t) => {
		const table = await createTable(t);
		const arrowTable = tableFromArrays({
			id: BigInt64Array.from([1n, 2n, 3n]),
			name: ['a', 'b', 'c'],
			value: Float64Array.from([1.5, 2.5, -3]),
		});

		await table.upload('arrow').create(arrowTable);

		assert.deepEqual(await readSorted(table), [
			{ id: 1, name: 'a', value: 1.5 },
			{ id: 2, name: 'b', value: 2.5 },
			{ id: 3, name: 'c', value: -3 },
		]);
	});

	test('rows that are not objects are rejected', async (t) => {
		const table = await createTable(t);

		await assert.rejects(table.upload('rows').create([{ id: 1 }, 2]), ValueError);
		assert.equal(await table.upload('rows').exists(), false);
	});

	test('quoted newlines', async (t) => {
		const table = await createTable(t);
		const content = 'id,text\n1,"first\nsecond"\n2,"a ""quoted"" word"\n3,plain\n';

		await table.upload('newlines.csv').create(encode(content), { hasQuotedNewlines: true });

		assert.deepEqual(column(await readSorted(table), 'text'), ['first\nsecond', 'a "quoted" word', 'plain']);
	});

	test('delimited options', async (t) => {
		const table = await createTable(t);

		await table.upload('data.psv').create(encode('1|a|NA\n2|NA|2.5\n'), {
			type: 'delimited',
			delimiter: '|',
			hasHeaderRow: false,
			nullMarkers: ['NA'],
		});

		const variables = await table.listVariables();
		assert.equal(variables.length, 3);
		const rows = (await readSorted(table, variables[0].name)).map(Object.values);
		assert.deepEqual(
			rows.map((row) => row.map((value) => value === null)),
			[
				[false, false, true],
				[false, true, false],
			],
		);
	});

	test('metadata sets variable metadata', async (t) => {
		const table = await createTable(t);

		await table.upload('small.csv').create(encode(SMALL_CSV), {
			metadata: {
				name: { label: 'Name label', description: 'Name description', valueLabels: { a: 'The letter a' } },
			},
		});

		const variable = await table.variable('name').get();
		assert.equal(variable.properties.label, 'Name label');
		assert.equal(variable.properties.description, 'Name description');
		assert.deepEqual(variable.properties.valueLabels, [{ value: 'a', label: 'The letter a' }]);
	});

	test('reports progress', async (t) => {
		const table = await createTable(t);
		const content = encode(SMALL_CSV);
		const progress = [];

		await table.upload('small.csv').create(content, { onProgress: (p) => progress.push(p) });

		assert.deepEqual(progress.at(0), { bytesUploaded: 0, totalBytes: content.length });
		assert.deepEqual(progress.at(-1), { bytesUploaded: content.length, totalBytes: content.length });
	});

	test('an aborted upload stops', async (t) => {
		const table = await createTable(t);
		const controller = new AbortController();
		controller.abort(new Error('Stopped'));

		await assert.rejects(table.upload('small.csv').create(encode(SMALL_CSV), { signal: controller.signal }), {
			message: 'Stopped',
		});
		assert.equal(await table.upload('small.csv').exists(), false);
	});

	test('the append merge strategy', async (t) => {
		const table = await createTable(t, { uploadMergeStrategy: 'append' });

		await table.upload('first.csv').create(encode(SMALL_CSV));
		await table.upload('second.csv').create(encode(SMALL_CSV));

		assert.equal((await table.get()).properties.numRows, 6);
		assert.deepEqual((await table.listUploads()).map((upload) => upload.name).sort(), ['first.csv', 'second.csv']);
	});

	test('the replace merge strategy, across versions', async (t) => {
		// The uploads to a new version replace the previous version's data, rather than adding to it
		const dataset = await createDataset(t);
		const table = await dataset.table('data').create({ uploadMergeStrategy: 'replace' });
		await table.upload('first.csv').create(encode(SMALL_CSV));
		await dataset.release({ waitForFinalization: true });

		const nextTable = (await dataset.createNextVersion()).table('data');
		await nextTable.upload('second.csv').create(encode('id,name,value\n9,z,9.5\n'));

		assert.deepEqual(column(await readSorted(nextTable), 'id'), [9]);
		assert.deepEqual(
			(await nextTable.listUploads()).map((upload) => upload.name),
			['second.csv'],
		);
	});

	test('the append merge strategy, across versions', async (t) => {
		const dataset = await createDataset(t);
		const table = await dataset.table('data').create();
		await table.upload('first.csv').create(encode(SMALL_CSV));
		await dataset.release({ waitForFinalization: true });

		const nextTable = (await dataset.createNextVersion()).table('data');
		await nextTable.upload('second.csv').create(encode('id,name,value\n9,z,9.5\n'));

		assert.equal((await nextTable.get()).properties.numRows, 4);
	});

	// Uploads with the same schema are read as one response from listRows
	test('reading a table with several unreleased uploads', async (t) => {
		const table = await createTable(t);
		await table.upload('first.csv').create(encode(SMALL_CSV));
		await table.upload('second.csv').create(encode('id,name,value\n9,z,9.5\n'));

		assert.deepEqual(column(await readSorted(table), 'id'), [1, 2, 3, 9]);
	});

	// listRows can't combine these into one response, so they're read through a read session, with each upload's rows
	//   conformed to the table's variables
	test('reading unreleased uploads with different schemas', async (t) => {
		const table = await createTable(t);
		await table.upload('first.csv').create(encode('id,code,extra\n1,10,x\n2,20,y\n'));
		await table.upload('second.csv').create(encode('id,code\n3,abc\n'));

		assert.deepEqual(
			Object.fromEntries((await table.listVariables()).map(({ name, properties }) => [name, properties.type])),
			{ id: 'integer', code: 'string', extra: 'string' },
		);
		const expected = [
			{ id: 1, code: '10', extra: 'x' },
			{ id: 2, code: '20', extra: 'y' },
			{ id: 3, code: 'abc', extra: null },
		];
		assert.deepEqual(await readSorted(table), expected);

		let numRows = 0;
		for await (const batch of table.toArrowBatchIterator()) {
			numRows += batch.numRows;
		}
		assert.equal(numRows, expected.length);
	});

	test('name conflicts', async (t) => {
		const table = await createTable(t);
		const original = await table.upload('data.csv').create(encode(SMALL_CSV));

		await assert.rejects(table.upload('data.csv').create(encode(SMALL_CSV)), {
			name: 'ValueError',
			message: /already exists/,
		});

		const existing = await table.upload('data.csv').create(encode(SMALL_CSV), { ifNotExists: true });
		assert.equal(existing.uri, original.uri);
		assert.equal((await table.listUploads()).length, 1);

		const renamed = await table.upload('data.csv').create(encode(SMALL_CSV), { renameOnConflict: true });
		assert.notEqual(renamed.name, 'data.csv');
		assert.equal((await table.listUploads()).length, 2);

		await table.upload('data.csv').create(encode('id,name,value\n9,z,9.5\n'), { replaceOnConflict: true });
		assert.equal((await table.listUploads()).length, 2);
		assert.equal((await table.get()).properties.numRows, 4);

		await assert.rejects(
			table.upload('data.csv').create(encode(SMALL_CSV), { renameOnConflict: true, replaceOnConflict: true }),
			ValueError,
		);
	});

	test('a failed upload throws a JobError', async (t) => {
		const table = await createTable(t);

		await assert.rejects(table.upload('jagged.csv').create(encode(JAGGED_CSV)), (error) => {
			assert.ok(error instanceof JobError);
			assert.equal(error.status, 'failed');
			assert.equal(error.kind, 'upload');
			return true;
		});
		assert.equal(await table.upload('jagged.csv').exists(), true);
	});

	test('a failed upload can be removed, without throwing', async (t) => {
		const table = await createTable(t);

		const upload = await table
			.upload('jagged.csv')
			.create(encode(JAGGED_CSV), { removeOnFail: true, raiseOnFail: false });

		assert.equal(upload.properties.status, 'failed');
		assert.equal(await upload.exists(), false);
	});

	test('allowJaggedRows', async (t) => {
		const table = await createTable(t);

		await table.upload('jagged.csv').create(encode(JAGGED_CSV), { allowJaggedRows: true });

		const rows = await readSorted(table, 'a');
		assert.deepEqual(column(rows, 'a'), [1, 3, 4]);
		assert.deepEqual(column(rows, 'b'), [2, null, 5]);
	});

	test('skipBadRecords', async (t) => {
		const table = await createTable(t);

		await table.upload('jagged.csv').create(encode(JAGGED_CSV), { skipBadRecords: true });

		assert.deepEqual(column(await readSorted(table, 'a'), 'a'), [1, 4]);
	});

	test('waitForFinish: false returns once the data is uploaded', async (t) => {
		const table = await createTable(t);

		const upload = await table.upload('small.csv').create(encode(SMALL_CSV), { waitForFinish: false });

		assert.ok(upload.properties.status);
		while ((await upload.get()).properties.status !== 'completed') {
			assert.notEqual(upload.properties.status, 'failed');
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		assert.deepEqual(await readSorted(upload), SMALL_ROWS);
	});

	test('a large upload goes through a resumable upload', async (t) => {
		// Content over 8MB is uploaded resumably, in chunks
		const table = await createTable(t);
		const content = largeCsv(250_000);
		assert.ok(content.length > 2 ** 23);
		let progressReports = 0;

		const upload = await table.upload('large.csv').create(new Blob([content]), {
			onProgress: () => progressReports++,
		});

		assert.equal(upload.properties.numRows, 250_000);
		assert.equal((await table.get()).properties.numRows, 250_000);
		assert.ok(progressReports >= 2);
	});

	test(
		'a large upload from a file path',
		{ skip: !settings.runSlow && 'slow; set REDIVIS_TEST_SLOW=1' },
		async (t) => {
			const table = await createTable(t);
			const directory = await mkdtemp(join(tmpdir(), 'redivis-test-'));
			t.after(() => rm(directory, { recursive: true, force: true }));
			const path = join(directory, 'huge.csv');
			await writeFile(path, largeCsv(2_000_000));

			const upload = await table.upload().create(path);

			assert.equal(upload.properties.numRows, 2_000_000);
		},
	);

	test('a transfer from a Redivis table', async (t) => {
		const table = await createTable(t);
		const tiny = await sample.tiny();

		await table.upload('transferred').create({
			transferSpecification: { sourceType: 'redivis', sourcePath: tiny.qualifiedReference },
		});

		assert.deepEqual(await readSorted(table), tinyRows());
	});

	test('a stream upload', async (t) => {
		const table = await createTable(t);
		const upload = await table.upload('stream').create({
			type: 'stream',
			schema: [
				{ name: 'id', type: 'integer' },
				{ name: 'name', type: 'string' },
				{ name: 'when', type: 'dateTime' },
			],
		});

		await upload.insertRows([
			{ id: 1, name: 'a', when: '2020-01-01T00:00:00' },
			{ id: 2, name: null, when: null },
		]);
		await upload.insertRows({ rows: [{ id: 3, name: 'c', when: '2021-06-15T12:30:00' }] });

		assert.deepEqual(Object.fromEntries((await upload.listVariables()).map((v) => [v.name, v.type])), {
			id: 'integer',
			name: 'string',
			when: 'dateTime',
		});
		const rows = sortedBy(await upload.toRowsArray());
		assert.deepEqual(column(rows, 'id'), [1, 2, 3]);
		assert.deepEqual(column(rows, 'name'), ['a', null, 'c']);
		assert.equal(rows[0].when.toString(), '2020-01-01T00:00:00');
	});

	test('a stream upload keeps large integers exact', async (t) => {
		const table = await createTable(t);
		const upload = await table
			.upload('stream')
			.create({ type: 'stream', schema: [{ name: 'id', type: 'integer' }] });

		await upload.insertRows([{ id: 9007199254740993n }]);

		assert.deepEqual(await upload.toRowsArray({ bigInt: true }), [{ id: 9007199254740993n }]);
	});

	test('a stream upload without a schema infers large integers as integers', async (t) => {
		const table = await createTable(t);
		const upload = await table.upload('stream').create({ type: 'stream' });

		await upload.insertRows([{ id: 9007199254740993n }, { id: 1 }]);

		assert.equal((await upload.variable('id').get()).type, 'integer');
		assert.deepEqual(column(sortedBy(await upload.toRowsArray({ bigInt: true })), 'id'), [1n, 9007199254740993n]);
	});

	test('insertRows requires an array', async (t) => {
		const table = await createTable(t);

		await assert.rejects(table.upload('stream').insertRows({ rows: { id: 1 } }), ValueError);
	});

	test('the lifecycle of an upload', async (t) => {
		const table = await createTable(t);
		const upload = table.upload('small.csv');
		assert.equal(await upload.exists(), false);

		await upload.create(encode(SMALL_CSV));
		assert.equal(await upload.exists(), true);
		assert.equal((await upload.get()).properties.numRows, 3);
		assert.deepEqual(
			(await upload.listVariables()).map((variable) => variable.name),
			['id', 'name', 'value'],
		);
		assert.equal((await upload.variable('name').get()).type, 'string');

		await upload.delete();
		assert.equal(await upload.exists(), false);
		assert.equal((await table.get()).properties.numRows, 0);
	});
});
