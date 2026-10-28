import { jsonResponse, mockFetch } from './helpers.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import { ValueError } from '../../src/common/errors.js';

afterEach(() => {
	redivis.config({ defaultWorkflow: null, defaultDataset: null, defaultUser: null, defaultOrganization: null });
});

test('parses qualified dataset references', () => {
	const dataset = redivis.dataset('demo.my_dataset:abc1:v1_0');
	assert.equal(dataset.name, 'my_dataset');
	assert.equal(dataset.versionTag, 'v1_0');
	assert.equal(dataset.scopedReference, 'my_dataset:abc1:v1_0');
	assert.equal(dataset.qualifiedReference, 'demo.my_dataset:abc1:v1_0');
	assert.equal(dataset.uri, '/datasets/demo.my_dataset%3Aabc1%3Av1_0');
	// The owner could be either, until we know more
	assert.equal(dataset.user.name, 'demo');
	assert.equal(dataset.organization.name, 'demo');
});

test('accepts dotted version tags, and normalizes version tags', () => {
	assert.equal(redivis.dataset('demo.ds:v1.0').qualifiedReference, 'demo.ds:v1_0');
	assert.equal(redivis.dataset('ds', { organization: 'demo', version: '2_0' }).versionTag, 'v2_0');
	assert.equal(redivis.organization('demo').dataset('ds', { version: 'next' }).scopedReference, 'ds:next');
	assert.equal(redivis.organization('demo').dataset('ds').scopedReference, 'ds');
});

test('dataset and workflow owners fall back to the configured defaults', () => {
	assert.throws(() => redivis.dataset('ds'), ValueError);
	assert.throws(() => redivis.workflow('wf'), ValueError);

	redivis.config({ defaultOrganization: 'org' });
	assert.equal(redivis.dataset('ds').organization.name, 'org');
	redivis.config({ defaultUser: 'jane' });
	const workflow = redivis.workflow('wf');
	assert.equal(workflow.user.name, 'jane');
	assert.equal(workflow.organization, undefined);
	assert.equal(workflow.uri, '/workflows/jane.wf');
});

test('encodes owner names in URIs', () => {
	assert.equal(redivis.user('a b').uri, '/users/a%20b');
	assert.equal(redivis.organization('a/b').uri, '/organizations/a%2Fb');
});

test('parses qualified table references', () => {
	const table = redivis.table('demo.ds:v1.0.my_table');
	assert.equal(table.name, 'my_table');
	assert.equal(table.qualifiedReference, 'demo.ds:v1_0.my_table');
	assert.equal(table.uri, '/tables/demo.ds%3Av1_0.my_table');
	assert.equal(table.dataset.qualifiedReference, 'demo.ds:v1_0');
	assert.equal(table.workflow.qualifiedReference, 'demo.ds:v1_0');
});

test('builds table references from their container', () => {
	const datasetTable = redivis.organization('demo').dataset('ds').table('t');
	assert.equal(datasetTable.uri, '/tables/demo.ds.t');
	assert.equal(datasetTable.workflow, undefined);

	// Workflow tables resolve within their workflow, which also finds tables inherited through datasources
	const workflowTable = redivis.user('jane').workflow('wf').table('t');
	assert.equal(workflowTable.qualifiedReference, 'jane.wf.t');
	assert.equal(workflowTable.uri, '/workflows/jane.wf/tables/t');
});

test('unqualified tables resolve within the configured default workflow, then dataset', () => {
	assert.throws(() => redivis.table('t'), ValueError);

	redivis.config({ defaultDataset: 'demo.ds' });
	assert.equal(redivis.table('t').uri, '/tables/demo.ds.t');

	redivis.config({ defaultWorkflow: redivis.workflow('jane.wf') });
	assert.equal(redivis.table('t').uri, '/workflows/jane.wf/tables/t');
	assert.equal(redivis.currentWorkflow().qualifiedReference, 'jane.wf');
});

test('resolves an ambiguous owner or container from fetched properties', async () => {
	mockFetch(({ path }) => {
		if (path.startsWith('/datasets/')) {
			return jsonResponse({
				name: 'ds',
				owner: { kind: 'organization' },
				qualifiedReference: 'demo.ds:abc1',
				scopedReference: 'ds:abc1',
				uri: '/datasets/abc1',
			});
		}
		return jsonResponse({
			name: 't',
			container: { kind: 'workflow' },
			qualifiedReference: 'demo.wf.t:def2',
			scopedReference: 't:def2',
			uri: '/tables/def2',
		});
	});

	const dataset = await redivis.dataset('demo.ds').get();
	assert.equal(dataset.user, undefined);
	assert.equal(dataset.organization.name, 'demo');
	assert.equal(dataset.qualifiedReference, 'demo.ds:abc1');
	assert.equal(dataset.uri, '/datasets/abc1');

	const table = await redivis.table('demo.wf.t').get();
	assert.equal(table.dataset, undefined);
	assert.equal(table.workflow.name, 'wf');
	assert.equal(table.uri, '/tables/def2');
	assert.equal(table.getProperty('container').kind, 'workflow');
});

test('queries default to the configured workflow or dataset', async () => {
	const requests = mockFetch(() => jsonResponse({ id: 'q1', uri: '/queries/q1', status: 'completed' }));

	redivis.config({ defaultDataset: 'demo.ds' });
	await redivis.query('SELECT 1').get();
	await redivis.user('jane').workflow('wf').query('SELECT 2').get();
	await redivis.query('SELECT 3', { defaultDataset: redivis.dataset('demo.other') }).get();

	const creates = requests.filter(({ method }) => method === 'POST').map(({ body }) => body);
	assert.deepEqual(creates, [
		{ query: 'SELECT 1', defaultDataset: 'demo.ds' },
		{ query: 'SELECT 2', defaultWorkflow: 'jane.wf' },
		{ query: 'SELECT 3', defaultDataset: 'demo.other' },
	]);
});

test('lists resources as class instances', async () => {
	mockFetch(({ path }) => {
		if (path.endsWith('/datasets')) {
			return jsonResponse({ results: [{ name: 'ds', qualifiedReference: 'demo.ds', uri: '/datasets/x' }] });
		}
		return jsonResponse({ results: [{ name: 't1' }, { name: 't2' }] });
	});
	const [dataset] = await redivis.organization('demo').listDatasets();
	assert.equal(dataset.uri, '/datasets/x');
	assert.equal(dataset.organization.name, 'demo');

	const tables = await dataset.listTables({ maxResults: 2 });
	assert.deepEqual(
		tables.map((table) => table.qualifiedReference),
		['demo.ds.t1', 'demo.ds.t2'],
	);
});
