// Workflows, and the datasources, transforms, and parameters in them.
import { cleanUp, createWorkflow, owner, sample, skip, uniqueName } from './live.js';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import Datasource from '../../src/classes/Datasource.js';
import Notebook from '../../src/classes/Notebook.js';
import Parameter from '../../src/classes/Parameter.js';
import Table from '../../src/classes/Table.js';
import Transform from '../../src/classes/Transform.js';
import Workflow from '../../src/classes/Workflow.js';
import { sortedBy, tinyRows } from './data.js';

describe('workflows', { skip }, () => {
	/** @type {Workflow} */
	let workflow;

	// Shared by the tests, which add to it
	before(async () => {
		workflow = await owner.workflow(uniqueName('workflow')).create({ description: 'Created by the tests' });
	});
	after(() => workflow && cleanUp(() => workflow.delete()));

	// Adds a dataset to the workflow, unless an earlier test already did
	async function addDatasource(dataset) {
		const datasource = workflow.datasource(dataset);
		return (await datasource.exists()) ? datasource.get() : datasource.create();
	}

	test('create', async () => {
		assert.ok(workflow instanceof Workflow);
		assert.equal(await workflow.exists(), true);
		assert.equal(workflow.properties.kind, 'workflow');
		assert.equal(workflow.properties.description, 'Created by the tests');
		assert.equal(workflow.properties.publicAccessLevel, 'none');
		assert.ok(
			workflow.qualifiedReference.startsWith(`${owner.name}.${workflow.name}:`),
			workflow.qualifiedReference,
		);
	});

	test('create, with an owner resolved from a qualified reference', async (t) => {
		const name = uniqueName('workflow');

		const created = await redivis.workflow(`${owner.name}.${name}`).create({ isPublic: true });
		t.after(() => cleanUp(() => created.delete()));

		assert.equal(created.name, name);
		assert.equal(created.properties.publicAccessLevel, 'view');
		assert.equal((created.organization || created.user).name, owner.name);
		assert.equal(created.organization ? 'organization' : 'user', owner.properties.kind);
	});

	test('delete', async (t) => {
		const created = await createWorkflow(t);

		await created.delete();

		assert.equal(await created.exists(), false);
		await assert.rejects(redivis.workflow(created.qualifiedReference).get(), redivis.errors.NotFoundError);
	});

	test('get by qualified reference', async () => {
		const fetched = await redivis.workflow(workflow.qualifiedReference).get();

		assert.equal(fetched.properties.id, workflow.properties.id);
		assert.equal(fetched.name, workflow.name);
		// Whether the owner is a user or an organization is resolved from the fetched properties
		assert.equal(fetched.organization ? 'organization' : 'user', owner.properties.kind);
	});

	test('listed by its owner', async () => {
		const listed = await owner.listWorkflows();

		assert.ok(listed.every((w) => w instanceof Workflow));
		assert.ok(listed.map((w) => w.properties.id).includes(workflow.properties.id));
	});

	test('a missing workflow', async () => {
		assert.equal(await owner.workflow(uniqueName('missing')).exists(), false);
	});

	test('a query scoped to the workflow', async () => {
		assert.deepEqual(await workflow.query('SELECT 1 AS x').toRowsArray(), [{ x: 1 }]);
	});

	test('a datasource', async (t) => {
		const dataset = await sample.dataset();

		const datasource = await addDatasource(dataset);
		t.after(() => cleanUp(() => datasource.delete()));

		assert.equal(await datasource.exists(), true);
		assert.equal((await datasource.sourceDataset()).properties.id, dataset.properties.id);
		const listed = await workflow.listDatasources();
		assert.ok(listed.every((d) => d instanceof Datasource));
		assert.ok(listed.map((d) => d.uri).includes(datasource.uri));

		await datasource.delete();
		assert.equal(await datasource.exists(), false);
		assert.ok(!(await workflow.listDatasources()).map((d) => d.uri).includes(datasource.uri));
	});

	test('a transform', async (t) => {
		const tiny = await sample.tiny();
		await addDatasource(tiny.dataset);

		const transform = await workflow.transform(uniqueName('transform')).create({
			sourceTable: tiny,
			query: 'SELECT id, Key FROM _source_ WHERE Boolean',
		});
		t.after(() => cleanUp(() => transform.delete()));
		assert.equal(await transform.exists(), true);
		assert.equal((await transform.sourceTable()).properties.id, tiny.properties.id);

		await transform.run();

		assert.equal(transform.properties.lastRunJob.status, 'completed');
		const rows = await (await transform.outputTable()).toRowsArray();
		assert.deepEqual(
			sortedBy(rows),
			tinyRows()
				.filter((row) => row.Boolean)
				.map(({ id, Key }) => ({ id, Key })),
		);
		assert.ok((await workflow.listTransforms()).map((t) => t.name).includes(transform.name));

		await transform.delete();
		assert.equal(await transform.exists(), false);
		assert.ok(!(await workflow.listTransforms()).map((t) => t.name).includes(transform.name));
	});

	test('a parameter', async (t) => {
		const name = uniqueName('param');
		const parameter = await workflow.parameter(name).create({ type: 'string', values: ['a', 'b'] });
		t.after(() => cleanUp(() => parameter.delete()));
		assert.match(parameter.uri, /^\/workflows\/.+\/parameters\//);

		assert.equal(await parameter.exists(), true);
		assert.deepEqual(await parameter.getValues(), ['a', 'b']);
		assert.ok((await workflow.listParameters()).map((p) => p.name).includes(name));

		await parameter.update({ values: ['c'] });
		assert.deepEqual(await parameter.getValues(), ['c']);

		await parameter.delete();
		assert.equal(await parameter.exists(), false);
	});

	test('list contents', async () => {
		const tables = await workflow.listTables();
		assert.ok(tables.every((table) => table instanceof Table && table.workflow === workflow));
		assert.ok((await workflow.listTables({ includeDatasources: true })).length >= tables.length);
		assert.ok((await workflow.listNotebooks()).every((n) => n instanceof Notebook));
		assert.ok((await workflow.listParameters()).every((p) => p instanceof Parameter));
		assert.ok((await workflow.listTransforms()).every((t) => t instanceof Transform));
	});
});
