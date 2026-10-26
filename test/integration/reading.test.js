// Reading tables and uploads into each of the supported forms, verified against the data that was uploaded.
import { sample, skip } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { RecordBatch, Table as ArrowTable, Type } from 'apache-arrow';
import redivis from '../../index.js';
import { ReadStream } from '../../src/classes/TabularReader.js';
import { TINY_VARIABLE_TYPES, parseCsv, pick, sortedBy, tinyRows, typedRows } from './data.js';
import { column, readSorted } from './helpers.js';

const { ValueError } = redivis.errors;

async function tempDirectory(t) {
	const directory = await mkdtemp(join(tmpdir(), 'redivis-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

// Rows with each value as a string, sorted by id, as they're read from a CSV or JSON file
function asStrings(rows) {
	return [...rows]
		.sort((a, b) => Number(a.id) - Number(b.id))
		.map((row) => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, String(value)])));
}

// Comparable representations of Temporal values, which aren't deepEqual to equivalent instances
function comparable(rows) {
	return rows.map((row) =>
		Object.fromEntries(
			Object.entries(row).map(([name, value]) => [
				name,
				value && typeof value === 'object' && /^Temporal\./.test(value[Symbol.toStringTag])
					? `${value[Symbol.toStringTag]} ${value}`
					: value,
			]),
		),
	);
}

describe('reading', { skip }, () => {
	test('toRowsArray()', async () => {
		const rows = await (await sample.tiny()).toRowsArray();

		assert.deepEqual(sortedBy(rows), tinyRows());
		assert.deepEqual(Object.keys(rows[0]), Object.keys(TINY_VARIABLE_TYPES));
	});

	test('toArrowTable()', async () => {
		const table = await (await sample.tiny()).toArrowTable();

		assert.ok(table instanceof ArrowTable);
		assert.equal(table.numRows, tinyRows().length);
		assert.deepEqual(
			table.schema.fields.map((field) => field.name),
			Object.keys(TINY_VARIABLE_TYPES),
		);
		assert.equal(table.schema.fields[0].type.typeId, Type.Int);
		assert.equal(table.schema.fields[0].type.bitWidth, 64);
		assert.equal(table.getChild('Boolean').type.typeId, Type.Bool);
		assert.equal(table.getChild('Key').type.typeId, Type.Utf8);
		assert.deepEqual(
			[...table.getChild('id')].map(Number).sort((a, b) => a - b),
			column(tinyRows(), 'id'),
		);
	});

	test('toArrowBatchIterator()', async () => {
		const batches = [];
		for await (const batch of (await sample.tiny()).toArrowBatchIterator()) {
			assert.ok(batch instanceof RecordBatch);
			batches.push(batch);
		}

		assert.equal(
			batches.reduce((total, batch) => total + batch.numRows, 0),
			tinyRows().length,
		);
		assert.deepEqual(
			[...new ArrowTable(batches).getChild('id')].map(Number).sort((a, b) => a - b),
			column(tinyRows(), 'id'),
		);
	});

	test('breaking out of an iterator stops the read', async () => {
		let rowsRead = 0;
		for await (const batch of (await sample.tiny()).toArrowBatchIterator({ maxParallelization: 1 })) {
			rowsRead += batch.numRows;
			break;
		}

		assert.ok(rowsRead > 0);
	});

	test('maxResults', async () => {
		const table = await sample.tiny();

		assert.equal((await table.toRowsArray(10)).length, 10);
		assert.equal((await table.toArrowTable({ maxResults: 7 })).numRows, 7);
		let rowsRead = 0;
		for await (const batch of table.toArrowBatchIterator(5)) {
			rowsRead += batch.numRows;
		}
		assert.equal(rowsRead, 5);
	});

	test('maxResults of 0', async () => {
		const table = await (await sample.tiny()).toArrowTable(0);

		assert.equal(table.numRows, 0);
		assert.deepEqual(
			table.schema.fields.map((field) => field.name),
			Object.keys(TINY_VARIABLE_TYPES),
		);
	});

	test('selected variables are returned in the order given, matched case-insensitively', async () => {
		const rows = await (await sample.tiny()).toRowsArray({ variables: ['text', 'ID'] });

		assert.deepEqual(Object.keys(rows[0]), ['Text', 'id']);
		assert.deepEqual(sortedBy(rows), pick(tinyRows(), ['Text', 'id']));
	});

	test('an unknown variable is rejected', async () => {
		await assert.rejects((await sample.tiny()).toRowsArray({ variables: ['id', 'nope'] }), {
			name: 'ValueError',
			message: /"nope" was not found/,
		});
	});

	test('a batch preprocessor transforms, or drops, batches', async () => {
		const table = await sample.tiny();

		const rows = await table.toRowsArray({
			variables: ['id', 'Key'],
			batchPreprocessor: (batch) => batch.select(['id']),
		});
		assert.deepEqual(Object.keys(rows[0]), ['id']);

		assert.equal((await table.toArrowTable({ batchPreprocessor: () => null })).numRows, 0);
	});

	test('reports progress', async () => {
		const progress = [];

		await (await sample.tiny()).toArrowTable({ onProgress: (p) => progress.push(p) });

		assert.ok(progress.length > 0);
		assert.deepEqual(progress.at(-1), { rowsRead: tinyRows().length, totalRows: tinyRows().length });
	});

	test('an aborted read stops', async () => {
		const controller = new AbortController();
		controller.abort(new Error('Stopped'));

		await assert.rejects((await sample.tiny()).toArrowTable({ signal: controller.signal }), { message: 'Stopped' });
	});

	test('maxBytes limits how much is read into memory', async () => {
		await assert.rejects((await sample.tiny()).toArrowTable({ maxBytes: 10 }), ValueError);
	});

	test('read by qualified reference', async () => {
		const table = redivis.table((await sample.tiny()).qualifiedReference);

		assert.deepEqual(await readSorted(table), tinyRows());
	});

	test('read an upload', async () => {
		const upload = (await sample.tiny()).upload('tiny.csv');

		assert.deepEqual(await readSorted(upload), tinyRows());
	});

	for (const targetCount of [1, 3]) {
		test(`toReadStreams(${targetCount})`, async () => {
			const streams = await (await sample.tiny()).toReadStreams(targetCount);

			assert.ok(streams.length >= 1 && streams.length <= targetCount);
			assert.ok(streams.every((stream) => stream instanceof ReadStream));
			const rows = (await Promise.all(streams.map((stream) => stream.toRowsArray()))).flat();
			assert.deepEqual(sortedBy(rows), tinyRows());
		});
	}

	test('read streams with selected variables', async () => {
		const streams = await (await sample.tiny()).toReadStreams(2, { variables: ['Key', 'id'] });

		const tables = await Promise.all(streams.map((stream) => stream.toArrowTable()));
		assert.ok(tables.every((table) => table.schema.fields.map((f) => f.name).join() === 'Key,id'));
		const rows = (await Promise.all(streams.map((stream) => stream.toRowsArray()))).flat();
		assert.deepEqual(sortedBy(rows), pick(tinyRows(), ['Key', 'id']));
	});

	test('read streams are already part of a read session', async () => {
		const [stream] = await (await sample.tiny()).toReadStreams(1);

		await assert.rejects(stream.toReadStreams(), ValueError);
		await assert.rejects(stream.toRowsArray({ variables: ['id'] }), ValueError);
		await assert.rejects(stream.download(), ValueError);
	});

	test('read streams reject an invalid count', async () => {
		await assert.rejects((await sample.tiny()).toReadStreams(0), ValueError);
	});

	test('typed values round trip', async () => {
		const rows = sortedBy(await (await sample.typed()).toRowsArray({ bigInt: true }));

		const expected = typedRows().map((row) => ({
			...row,
			id: BigInt(row.id),
		}));
		assert.deepEqual(comparable(rows), comparable(expected));
	});

	test('integers are Numbers by default, losing precision beyond 2^53', async () => {
		const rows = sortedBy(await (await sample.typed()).toRowsArray());

		assert.equal(typeof rows[0].id, 'number');
		assert.equal(rows[0].big_int_col, Number(9007199254740993n));
	});

	test('temporal: false returns Dates and time strings', async () => {
		const rows = sortedBy(await (await sample.typed()).toRowsArray({ temporal: false }));

		assert.ok(rows[0].date_col instanceof Date);
		assert.equal(rows[0].date_col.toISOString(), '2020-01-01T00:00:00.000Z');
		assert.ok(rows[0].datetime_col instanceof Date);
		// Dates only have millisecond precision
		assert.equal(rows[0].datetime_col.toISOString(), '2020-01-01T12:30:15.123Z');
		assert.equal(rows[0].time_col, '12:30:15');
		assert.equal(rows[2].time_col, '23:59:59.500000');
	});

	test('typed values as arrow types', async () => {
		const table = await (await sample.typed()).toArrowTable();

		const typeIds = Object.fromEntries(table.schema.fields.map((field) => [field.name, Type[field.type.typeId]]));
		assert.deepEqual(typeIds, {
			id: 'Int',
			big_int_col: 'Int',
			float_col: 'Float',
			string_col: 'Utf8',
			unicode_col: 'Utf8',
			bool_col: 'Bool',
			date_col: 'Date',
			datetime_col: 'Timestamp',
			time_col: 'Time',
		});
	});

	for (const format of ['csv', 'parquet', 'jsonl']) {
		test(`download as ${format}`, async (t) => {
			const directory = await tempDirectory(t);

			const paths = await (await sample.tiny()).download(directory, { format });

			assert.deepEqual(
				paths.map((path) => basename(path)),
				[`tiny.${format}`],
			);
			const content = await readFile(paths[0]);
			if (format === 'csv') {
				assert.deepEqual(asStrings(parseCsv(content.toString())), asStrings(tinyRows()));
			} else if (format === 'jsonl') {
				const rows = content
					.toString()
					.trimEnd()
					.split('\n')
					.map((line) => JSON.parse(line));
				assert.deepEqual(asStrings(rows), asStrings(tinyRows()));
			} else {
				// A parquet file starts and ends with its magic number
				assert.equal(content.subarray(0, 4).toString(), 'PAR1');
				assert.equal(content.subarray(-4).toString(), 'PAR1');
			}
		});
	}

	test('download to a file path', async (t) => {
		const path = join(await tempDirectory(t), 'out', 'my_table.csv');
		const table = await sample.tiny();

		assert.deepEqual(await table.download(path), [path]);
		assert.equal(parseCsv(await readFile(path, 'utf8')).length, tinyRows().length);

		const progress = [];
		await table.download(path, { overwrite: true, onProgress: (p) => progress.push(p.stage) });
		assert.ok(progress.includes('downloading'));
	});

	test('download into the current directory by default', async (t) => {
		const directory = await tempDirectory(t);
		const cwd = process.cwd();
		process.chdir(directory);
		t.after(() => process.chdir(cwd));

		await (await sample.tiny()).download();

		assert.deepEqual(await readdir(directory), ['tiny.csv']);
	});

	test('download an upload', async (t) => {
		const directory = await tempDirectory(t);

		const paths = await (await sample.tiny()).upload('tiny.csv').download(directory);

		assert.equal(paths.length, 1);
		assert.deepEqual(asStrings(parseCsv(await readFile(paths[0], 'utf8'))), asStrings(tinyRows()));
	});
});
