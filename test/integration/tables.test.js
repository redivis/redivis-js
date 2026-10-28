// Table and variable metadata.
import { createTable, sample, skip, uniqueName } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import Upload from '../../src/classes/Upload.js';
import Variable from '../../src/classes/Variable.js';
import { TINY_VARIABLE_TYPES, TYPED_VARIABLE_TYPES, tinyRows } from './data.js';

const CODES_CSV = new TextEncoder().encode('code,value\na,1\nb,2\n');

// Each test creates its own tables, or only reads, so they can run concurrently
describe('tables', { skip, concurrency: true }, () => {
	test('create', async (t) => {
		const table = await createTable(t, { description: 'A table' });

		assert.equal(await table.exists(), true);
		assert.equal(table.properties.description, 'A table');
		assert.equal(table.properties.uploadMergeStrategy, 'append');
		assert.equal(table.properties.isFileIndex, false);
		assert.equal(table.properties.numRows, 0);
	});

	test('create a file index table', async (t) => {
		const table = await createTable(t, { isFileIndex: true });

		assert.equal(table.properties.isFileIndex, true);
	});

	test('create with a merge strategy', async (t) => {
		const table = await createTable(t, { uploadMergeStrategy: 'replace' });

		assert.equal(table.properties.uploadMergeStrategy, 'replace');
	});

	test('update', async (t) => {
		const table = await createTable(t);
		const newName = `${table.name}_renamed`;

		await table.update({ name: newName, description: 'Updated', uploadMergeStrategy: 'replace' });

		assert.equal(table.name, newName);
		const fetched = await table.get();
		assert.equal(fetched.properties.description, 'Updated');
		assert.equal(fetched.properties.uploadMergeStrategy, 'replace');
	});

	test('delete', async () => {
		const dataset = (await sample.tiny()).dataset;
		const table = await dataset.table(uniqueName('delete')).create();

		await table.delete();

		assert.equal(await table.exists(), false);
	});

	test('get by qualified reference', async () => {
		const tiny = await sample.tiny();

		const table = await redivis.table(tiny.qualifiedReference).get();

		assert.equal(table.properties.id, tiny.properties.id);
		assert.equal(table.properties.numRows, tinyRows().length);
		assert.equal(table.properties.container.kind, 'dataset');
		// Whether the container is a dataset or a workflow is resolved from the fetched properties
		assert.ok(table.dataset);
		assert.equal(table.workflow, undefined);
	});

	test('list uploads', async () => {
		const uploads = await (await sample.tiny()).listUploads();

		assert.deepEqual(
			uploads.map((upload) => upload.name),
			['tiny.csv'],
		);
		assert.ok(uploads[0] instanceof Upload);
		assert.equal(uploads[0].properties.status, 'completed');
	});

	test('list variables', async () => {
		const variables = await (await sample.tiny()).listVariables();

		assert.ok(variables.every((variable) => variable instanceof Variable));
		assert.deepEqual(
			variables.map((v) => v.name),
			Object.keys(TINY_VARIABLE_TYPES),
		);
		assert.deepEqual(Object.fromEntries(variables.map((v) => [v.name, v.type])), TINY_VARIABLE_TYPES);
	});

	test('list variables, up to maxResults', async () => {
		const table = await sample.tiny();

		assert.equal((await table.listVariables(2)).length, 2);
		assert.equal((await table.listVariables({ maxResults: 3 })).length, 3);
	});

	test('variables of each type', async () => {
		const variables = await (await sample.typed()).listVariables();

		assert.deepEqual(Object.fromEntries(variables.map((v) => [v.name, v.type])), TYPED_VARIABLE_TYPES);
	});

	test('variable statistics', async () => {
		const keys = tinyRows().map((row) => row.Key);

		const statistics = await (await sample.tiny()).variable('Key').getStatistics();

		assert.equal(statistics.status, 'completed');
		assert.equal(statistics.count, keys.length);
		assert.equal(statistics.numDistinct, new Set(keys).size);
	});

	test('update a variable', async (t) => {
		const table = await createTable(t);
		await table.upload('data.csv').create(CODES_CSV);

		const variable = await table.variable('code').update({
			label: 'A code',
			description: 'Identifies the row',
			valueLabels: [{ value: 'a', label: 'The letter a' }],
		});

		assert.equal(variable.properties.label, 'A code');
		const fetched = await table.variable('code').get();
		assert.equal(fetched.properties.description, 'Identifies the row');
		assert.deepEqual(fetched.properties.valueLabels, [{ value: 'a', label: 'The letter a' }]);
	});

	test('update variables in bulk', async (t) => {
		const table = await createTable(t);
		await table.upload('data.csv').create(CODES_CSV);

		await table.updateVariables([
			{ name: 'code', label: 'Code label' },
			{ name: 'value', description: 'Value description' },
		]);

		assert.equal((await table.variable('code').get()).properties.label, 'Code label');
		assert.equal((await table.variable('value').get()).properties.description, 'Value description');
	});

	for (const name of ['Key', 'key', 'KEY']) {
		test(`variables are looked up case-insensitively (${name})`, async () => {
			const variable = await (await sample.tiny()).variable(name).get();

			assert.equal(variable.properties.name, 'Key');
			assert.equal(variable.type, 'string');
		});
	}
});
