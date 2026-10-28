// SQL queries, run against the uploaded sample data.
import { sample, skip } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'apache-arrow';
import redivis from '../../index.js';
import Query from '../../src/classes/Query.js';
import { TINY_VARIABLE_TYPES, parseCsv, pick, sortedBy, tinyRows } from './data.js';

const { APIError, JobError } = redivis.errors;
const TINY_VARIABLES = Object.keys(TINY_VARIABLE_TYPES);

// Queries of an unreleased version's tables also return the variables that identify each row's upload (_IMPORT_ID and
//   _IMPORT_NAME), so compare just the table's own variables
const dataVariables = (rows) => pick(rows, TINY_VARIABLES);

describe('queries', { skip }, () => {
	test('a query of a table, by its qualified reference', async () => {
		const tiny = await sample.tiny();
		const query = redivis.query(`
			SELECT Key, COUNT(*) AS n, SUM(Numeric) AS total
			FROM \`${tiny.qualifiedReference}\`
			GROUP BY Key
		`);

		const rows = sortedBy(await query.toRowsArray(), 'Key');

		const expected = {};
		for (const { Key, Numeric } of tinyRows()) {
			expected[Key] ??= { Key, n: 0, total: 0 };
			expected[Key].n++;
			expected[Key].total += Numeric;
		}
		assert.deepEqual(rows, sortedBy(Object.values(expected), 'Key'));
	});

	test('a query scoped to a dataset', async () => {
		const tiny = await sample.tiny();

		const rows = await tiny.dataset.query('SELECT * FROM tiny WHERE Boolean ORDER BY id').toRowsArray();

		assert.deepEqual(
			dataVariables(rows),
			tinyRows().filter((row) => row.Boolean),
		);
	});

	test('a query with a default dataset', async () => {
		const tiny = await sample.tiny();

		const rows = await redivis
			.query('SELECT id FROM tiny WHERE id <= 3', { defaultDataset: tiny.dataset })
			.toRowsArray();

		assert.deepEqual(sortedBy(rows), [{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	test('properties and variables', async () => {
		const tiny = await sample.tiny();
		const query = redivis.query(`SELECT id, Key FROM \`${tiny.qualifiedReference}\` WHERE id <= 10`);
		assert.equal(String(query), '<Query [uninitiated]>');

		const variables = await query.listVariables();

		assert.deepEqual(
			variables.map((v) => [v.name, v.type]),
			[
				['id', 'integer'],
				['Key', 'string'],
			],
		);
		assert.equal(query.properties.status, 'completed');
		assert.equal((await query.get()).properties.outputNumRows, 10);
		assert.equal((await (await query.variable('Key')).get()).type, 'string');
	});

	test('a query only runs once, however many reads it has', async () => {
		const query = redivis.query('SELECT 1 AS x');

		const [first, second] = await Promise.all([query.toRowsArray(), query.toArrowTable()]);

		assert.deepEqual(first, [{ x: 1 }]);
		assert.equal(second.numRows, 1);
		const id = query.properties.id;
		await query.toRowsArray();
		assert.equal(query.properties.id, id);
	});

	test('literal types', async () => {
		const query = redivis.query(`
			SELECT
				1 AS int_col,
				1.5 AS float_col,
				'text' AS string_col,
				TRUE AS bool_col,
				DATE '2020-01-02' AS date_col,
				DATETIME '2020-01-02 03:04:05.123456' AS datetime_col,
				TIME '03:04:05' AS time_col
			UNION ALL
			SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL
		`);

		const table = await query.toArrowTable();
		const typeIds = Object.fromEntries(table.schema.fields.map((field) => [field.name, Type[field.type.typeId]]));
		assert.deepEqual(typeIds, {
			int_col: 'Int',
			float_col: 'Float',
			string_col: 'Utf8',
			bool_col: 'Bool',
			date_col: 'Date',
			datetime_col: 'Timestamp',
			time_col: 'Time',
		});

		const rows = (await query.toRowsArray()).sort((a, b) => (a.int_col === null) - (b.int_col === null));
		assert.deepEqual(Object.fromEntries(Object.entries(rows[0]).map(([name, value]) => [name, String(value)])), {
			int_col: '1',
			float_col: '1.5',
			string_col: 'text',
			bool_col: 'true',
			date_col: '2020-01-02',
			datetime_col: '2020-01-02T03:04:05.123456',
			time_col: '03:04:05',
		});
		assert.ok(Object.values(rows[1]).every((value) => value === null));
	});

	test('an empty result', async () => {
		const tiny = await sample.tiny();
		const query = redivis.query(`SELECT id, Key FROM \`${tiny.qualifiedReference}\` WHERE FALSE`);

		const table = await query.toArrowTable();

		assert.equal(table.numRows, 0);
		assert.deepEqual(
			table.schema.fields.map((field) => field.name),
			['id', 'Key'],
		);
		assert.deepEqual(await query.toRowsArray(), []);
	});

	test('an invalid query throws', async () => {
		const query = redivis.query('SELECT * FROM a_table_that_does_not_exist');

		await assert.rejects(query.toRowsArray(), (error) => error instanceof JobError || error instanceof APIError);
	});

	test('read streams', async () => {
		const tiny = await sample.tiny();
		const query = redivis.query(`SELECT * FROM \`${tiny.qualifiedReference}\``);

		const streams = await query.toReadStreams(2);

		const rows = (await Promise.all(streams.map((stream) => stream.toRowsArray()))).flat();
		assert.deepEqual(sortedBy(dataVariables(rows)), tinyRows());
	});

	test('download', async (t) => {
		const directory = await mkdtemp(join(tmpdir(), 'redivis-test-'));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const tiny = await sample.tiny();
		const query = redivis.query(`SELECT id, Key FROM \`${tiny.qualifiedReference}\` ORDER BY id`);

		const paths = await query.download(directory);

		assert.equal(paths.length, 1);
		assert.match(paths[0], /query_.*\.csv$/);
		const rows = parseCsv(await readFile(paths[0], 'utf8'));
		assert.deepEqual(Object.keys(rows[0]), ['id', 'Key']);
		assert.deepEqual(
			sortedBy(rows.map(({ id, Key }) => ({ id: Number(id), Key }))),
			tinyRows().map(({ id, Key }) => ({ id, Key })),
		);
	});

	test('a query is a Query', () => {
		assert.ok(redivis.query('SELECT 1') instanceof Query);
	});
});
