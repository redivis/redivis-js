import { jsonResponse, mockFetch } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import Datasource from '../../src/classes/Datasource.js';
import Member from '../../src/classes/Member.js';
import Notebook from '../../src/classes/Notebook.js';
import Parameter from '../../src/classes/Parameter.js';
import Table from '../../src/classes/Table.js';
import Transform from '../../src/classes/Transform.js';
import Version from '../../src/classes/Version.js';
import { JobError, ValueError } from '../../src/common/errors.js';

// Mocks the API with a map of `METHOD /path` (or `METHOD /path?query`) to a response body or function. Unmatched
//   requests fail the test.
function mockRoutes(routes) {
	return mockFetch((request) => {
		const { method, path, url } = request;
		const route = routes[`${method} ${path}${url.search}`] ?? routes[`${method} ${path}`];
		if (route === undefined) {
			throw new Error(`Unexpected request: ${method} ${path}${url.search}`);
		}
		const response = typeof route === 'function' ? route(request) : route;
		return response instanceof Response ? response : jsonResponse(response);
	});
}

const summary = (requests) => requests.map(({ method, path, body }) => [`${method} ${path}`, body]);

test('dataset updates send only the options that were passed', async () => {
	const requests = mockRoutes({
		'PATCH /datasets/demo.ds': { name: 'ds', uri: '/datasets/demo.ds', owner: { kind: 'organization' } },
		'PATCH /datasets/demo.ds/variables': {},
	});
	const dataset = redivis.dataset('demo.ds');
	await dataset.update({ description: '', labelsToAdd: ['a'], tags: [] });
	await dataset.updateVariables([{ name: 'x', label: 'X' }]);

	assert.deepEqual(summary(requests), [
		['PATCH /datasets/demo.ds', { description: '', labelsToAdd: ['a'], tags: [] }],
		['PATCH /datasets/demo.ds/variables', { variables: [{ name: 'x', label: 'X' }] }],
	]);
	assert.equal(dataset.user, undefined);
	await assert.rejects(dataset.update({ labelz: [] }), ValueError);
});

test('datasets are created under their owner, once it is known whether that is a user or organization', async () => {
	const requests = mockRoutes({
		'GET /organizations/jane/datasets?maxResults=1': new Response(null, { status: 404 }),
		'POST /users/jane/datasets': { name: 'ds', uri: '/datasets/jane.ds', qualifiedReference: 'jane.ds' },
	});
	const dataset = await redivis.dataset('jane.ds').create({ description: 'Hi' });
	assert.equal(dataset.organization, undefined);
	assert.deepEqual(requests.at(-1).body, { name: 'ds', description: 'Hi', publicAccessLevel: 'none' });
});

test('workflows are created under their owner, once it is known whether that is a user or organization', async () => {
	const workflowProperties = {
		name: 'wf',
		uri: '/workflows/demo.wf',
		qualifiedReference: 'demo.wf',
		owner: { kind: 'organization', userName: 'demo' },
	};
	const requests = mockRoutes({
		'GET /organizations/demo/datasets?maxResults=1': { results: [] },
		'POST /organizations/demo/workflows': workflowProperties,
		'POST /users/jane/workflows': { ...workflowProperties, owner: { kind: 'user' } },
		'DELETE /workflows/demo.wf': new Response(null, { status: 204 }),
	});

	const workflow = await redivis.workflow('demo.wf').create({ description: 'Hi' });
	assert.equal(workflow.user, undefined);
	assert.equal(workflow.organization.name, 'demo');
	assert.deepEqual(requests.at(-1).body, { name: 'wf', description: 'Hi', isPublic: false });

	await redivis.user('jane').workflow('wf').create({ isPublic: true });
	assert.deepEqual(requests.at(-1).body, { name: 'wf', isPublic: true });
	await assert.rejects(redivis.user('jane').workflow('wf').create({ public: true }), ValueError);

	await workflow.delete();
	assert.equal(requests.at(-1).method, 'DELETE');
});

test('releases and unreleases dataset versions', async () => {
	const requests = mockRoutes({
		'POST /datasets/demo.ds/versions/next/release': { datasetUri: '/datasets/demo.ds:v2_0' },
		'GET /datasets/demo.ds:v2_0': { name: 'ds', uri: '/datasets/demo.ds:v2_0', version: { tag: 'v2.0' } },
		'POST /datasets/demo.ds:v2_0/versions/current/unrelease': { datasetUri: '/datasets/demo.ds:next' },
		'GET /datasets/demo.ds:next': { name: 'ds', uri: '/datasets/demo.ds:next', version: { tag: 'next' } },
	});
	const dataset = redivis.dataset('demo.ds');
	await dataset.release({ releaseNotes: 'Notes' });
	assert.equal(dataset.versionTag, 'v2_0');
	assert.deepEqual(requests[0].body, { releaseNotes: 'Notes' });
	await dataset.unrelease();
	assert.equal(dataset.uri, '/datasets/demo.ds:next');
});

test('releases and version deletions wait for finalization, when asked', async () => {
	const version = { tag: 'v2.0', uri: '/datasets/demo.ds/versions/v2_0', datasetUri: '/datasets/demo.ds:v2_0' };
	const requests = mockRoutes({
		'POST /datasets/demo.ds/versions/next/release': { ...version, isFinalizing: true },
		'GET /datasets/demo.ds/versions/v2_0': { ...version, isFinalizing: false },
		'GET /datasets/demo.ds:v2_0': { name: 'ds', uri: '/datasets/demo.ds:v2_0', version: { tag: 'v2.0' } },
		'DELETE /v': { tag: 'v1.0', uri: '/v', isDeleted: true, isFinalizing: true },
		'GET /v': { tag: 'v1.0', uri: '/v', isDeleted: true, isFinalizing: false },
	});
	const paths = () => requests.splice(0).map(({ method, path }) => `${method} ${path}`);

	await redivis.dataset('demo.ds').release({ waitForFinalization: true });
	assert.deepEqual(paths(), [
		'POST /datasets/demo.ds/versions/next/release',
		'GET /datasets/demo.ds/versions/v2_0',
		'GET /datasets/demo.ds:v2_0',
	]);

	// By default, the release returns as soon as it has been made
	await redivis.dataset('demo.ds').release();
	assert.deepEqual(paths(), ['POST /datasets/demo.ds/versions/next/release', 'GET /datasets/demo.ds:v2_0']);

	const deleted = await new Version('v1_0', {
		dataset: redivis.dataset('demo.ds'),
		properties: { uri: '/v' },
	}).delete({
		waitForFinalization: true,
	});
	assert.equal(deleted.getProperty('isFinalizing'), false);
	assert.deepEqual(paths(), ['DELETE /v', 'GET /v']);
});

test('createNextVersion() creates a next version, unless one exists', async () => {
	let hasNextVersion = false;
	mockRoutes({
		'GET /datasets/demo.ds': () => ({
			name: 'ds',
			uri: '/datasets/demo.ds',
			nextVersion: hasNextVersion ? { datasetUri: '/datasets/demo.ds:next' } : null,
		}),
		'POST /datasets/demo.ds/versions': () => {
			hasNextVersion = true;
			return {};
		},
		'GET /organizations/demo/datasets?maxResults=1': { results: [] },
		'GET /datasets/demo.ds%3Anext': { name: 'ds', uri: '/datasets/demo.ds:next', scopedReference: 'ds:next' },
	});
	const next = await redivis.dataset('demo.ds').createNextVersion();
	assert.equal(next.scopedReference, 'ds:next');
	await assert.rejects(redivis.dataset('demo.ds').createNextVersion(), /Next version already exists/);
	assert.equal((await redivis.dataset('demo.ds').createNextVersion({ ifNotExists: true })).uri, next.uri);
});

test('navigates between dataset versions', async () => {
	mockRoutes({
		'GET /datasets/demo.ds': { name: 'ds', uri: '/datasets/demo.ds', version: { tag: 'v1.1' } },
		'GET /datasets/demo.ds/versions/v1_1': {
			tag: 'v1.1',
			uri: '/datasets/demo.ds/versions/v1_1',
			previousVersion: { tag: 'v1.0' },
			nextVersion: null,
		},
		'GET /datasets/demo.ds/versions': { results: [{ tag: 'v1.0', uri: '/x/v1_0' }] },
	});
	const dataset = redivis.dataset('demo.ds');
	const version = await dataset.version();
	assert.ok(version instanceof Version);
	assert.equal(version.tag, 'v1_1');

	const previous = await dataset.previousVersion();
	assert.equal(previous.qualifiedReference, 'demo.ds:v1_0');
	assert.equal(await dataset.nextVersion(), null);

	const [listed] = await dataset.listVersions();
	assert.equal(listed.uri, '/x/v1_0');
	assert.equal(listed.dataset().qualifiedReference, 'demo.ds:v1_0');
});

test('versions can be updated, deleted, and undeleted', async () => {
	const requests = mockRoutes({
		'PATCH /datasets/demo.ds/versions/v1_0': { tag: 'v1.0', uri: '/v', label: 'L' },
		'DELETE /v': { tag: 'v1.0', uri: '/v', isDeleted: true },
		'POST /v/undelete': { tag: 'v1.0', uri: '/v', isDeleted: false },
	});
	const version = await redivis.dataset('demo.ds').version('1.0');
	assert.equal(await version.update({ label: 'L', releaseNotes: undefined }), version);
	assert.equal((await version.delete()).getProperty('isDeleted'), true);
	assert.equal((await version.undelete()).getProperty('isDeleted'), false);
	assert.deepEqual(requests[0].body, { label: 'L' });
});

test('organizations list members, datasets, and workflows', async () => {
	const requests = mockRoutes({
		'GET /organizations/demo/members': {
			results: [{ uri: '/organizations/demo/members/jane', user: { name: 'jane' }, status: 'approved' }],
		},
		'GET /organizations/demo/datasets': { results: [{ name: 'ds' }] },
		'GET /organizations/demo/workflows': { results: [{ name: 'wf', qualifiedReference: 'demo.wf' }] },
		'PATCH /organizations/demo/members/jane': { user: { name: 'jane', fullName: 'Jane' }, status: 'rejected' },
		'POST /organizations/demo/members/jane/comments': {},
	});
	const organization = redivis.organization('demo');
	const [member] = await organization.listMembers({ labels: ['a', 'b'], statuses: ['approved'] });
	assert.ok(member instanceof Member);
	assert.equal(member.user.name, 'jane');
	assert.equal(requests[0].url.searchParams.get('labels'), 'a,b');
	assert.equal(requests[0].url.searchParams.get('statuses'), 'approved');

	await member.update({ status: 'rejected', labelsToAdd: ['c'] });
	assert.equal(member.user.getProperty('fullName'), 'Jane');
	assert.equal(await member.addComment('Hi'), member);
	assert.deepEqual(requests.at(-1).body, { text: 'Hi' });

	const [dataset] = await organization.listDatasets(5, { labels: ['x'] });
	assert.equal(dataset.qualifiedReference, 'demo.ds');
	const [workflow] = await organization.listWorkflows();
	assert.equal(workflow.organization, organization);
});

test('users list datasets and workflows, and read secrets', async () => {
	mockRoutes({
		'GET /users/jane/datasets': { results: [{ name: 'ds' }] },
		'GET /users/jane/workflows': { results: [{ name: 'wf' }] },
		'GET /users/jane/secrets/api%20key': { value: 's3cret' },
		'GET /organizations/demo/secrets/k': { value: 'org' },
	});
	const user = redivis.user('jane');
	assert.equal((await user.listDatasets())[0].uri, '/datasets/jane.ds');
	assert.equal((await user.listWorkflows())[0].uri, '/workflows/jane.wf');
	assert.equal(await user.secret('api key').getValue(), 's3cret');
	assert.equal(await redivis.organization('demo').secret('k').getValue(), 'org');
});

test('workflows list their contents', async () => {
	const requests = mockRoutes({
		'GET /workflows/jane.wf/dataSources': { results: [{ id: 'abc', uri: '/workflows/jane.wf/dataSources/abc' }] },
		'GET /workflows/jane.wf/notebooks': { results: [{ name: 'nb' }] },
		'GET /workflows/jane.wf/transforms': { results: [{ name: 'tr' }] },
		'GET /workflows/jane.wf/parameters': { results: [{ name: 'p' }] },
		'GET /workflows/jane.wf/tables?includeDataSources=true&maxResults=100': { results: [{ name: 't' }] },
		'PATCH /workflows/jane.wf/variables': {},
	});
	const workflow = redivis.workflow('jane.wf');
	const [datasource] = await workflow.listDatasources();
	assert.ok(datasource instanceof Datasource);
	assert.equal(datasource.uri, '/workflows/jane.wf/dataSources/abc');

	const [notebook] = await workflow.listNotebooks();
	assert.ok(notebook instanceof Notebook);
	assert.equal(notebook.uri, '/notebooks/jane.wf.nb');
	const [transform] = await workflow.listTransforms();
	assert.ok(transform instanceof Transform);
	assert.equal(transform.qualifiedReference, 'jane.wf.tr');
	const [parameter] = await workflow.listParameters();
	assert.ok(parameter instanceof Parameter);
	const [table] = await workflow.listTables({ includeDatasources: true });
	assert.ok(table instanceof Table);
	await workflow.updateVariables([]);
	assert.deepEqual(requests.at(-1).body, { variables: [] });
});

test('datasources are created from a dataset or workflow, and deleted', async () => {
	const requests = mockRoutes({
		'HEAD /datasets/demo.ds': new Response(null, { status: 200 }),
		'HEAD /datasets/jane.other': new Response(null, { status: 404 }),
		'POST /workflows/jane.wf/dataSources': ({ body }) => ({
			id: 'x',
			uri: '/workflows/jane.wf/dataSources/x',
			...body,
		}),
		'DELETE /workflows/jane.wf/dataSources/x': new Response(null, { status: 204 }),
		'DELETE /workflows/jane.wf/dataSources/demo.ds': new Response(null, { status: 204 }),
	});
	const workflow = redivis.workflow('jane.wf');
	const datasource = await workflow.datasource('demo.ds').create();
	await workflow.datasource(redivis.workflow('jane.other')).create();
	const creates = requests.filter(({ method }) => method === 'POST').map(({ body }) => body);
	assert.deepEqual(creates, [{ sourceDataset: 'demo.ds' }, { sourceWorkflow: 'jane.other' }]);

	// At the URI it was created with, or by its source
	await datasource.delete();
	await workflow.datasource('demo.ds').delete();
	assert.deepEqual(
		requests.filter(({ method }) => method === 'DELETE').map(({ path }) => path),
		['/workflows/jane.wf/dataSources/x', '/workflows/jane.wf/dataSources/demo.ds'],
	);
});

test('datasources can change version, sample, and table mappings', async () => {
	const requests = mockRoutes({
		'GET /workflows/jane.wf/dataSources/demo.ds%3Asample': {
			uri: '/ds/1',
			sourceDataset: { qualifiedReference: 'demo.ds:abc1:v1_0:sample' },
		},
		'PATCH /ds/1': ({ body }) => ({ uri: '/ds/1', ...body }),
		'GET /ds/1': { uri: '/ds/1', sourceWorkflow: { qualifiedReference: 'jane.other' } },
	});
	const datasource = redivis.workflow('jane.wf').datasource('demo.ds:sample');
	await datasource.update({ version: 'v2.0' });
	await datasource.update({ sample: false, sourceDataset: redivis.dataset('demo.ds:abc1') });
	await datasource.update({
		mappedTables: [[redivis.dataset('demo.ds').table('old'), 'new']],
		sourceWorkflow: redivis.workflow('jane.other'),
	});

	const patches = requests.filter(({ method }) => method === 'PATCH').map(({ body }) => body);
	assert.deepEqual(patches, [
		// The sample is kept unless it's changed
		{ sourceDataset: 'demo.ds:abc1:v2_0:sample' },
		{ sourceDataset: 'demo.ds:abc1' },
		{ sourceWorkflow: 'jane.other', mappedTables: { old: 'new' } },
	]);

	await assert.rejects(
		datasource.update({ sample: true }),
		/aren't applicable to datasources that reference a workflow/,
	);
	await assert.rejects(datasource.sourceDataset(), /Use sourceWorkflow\(\) instead/);
	assert.equal((await datasource.sourceWorkflow()).qualifiedReference, 'jane.other');
});

test('tables are created in their dataset, and written to at their canonical URI', async () => {
	const requests = mockRoutes({
		'HEAD /datasets/demo.ds': new Response(null, { status: 200 }),
		'POST /datasets/demo.ds/tables': { name: 't', uri: '/tables/demo.ds.t', qualifiedReference: 'demo.ds.t' },
		'GET /workflows/jane.wf/tables/t': {
			name: 't',
			uri: '/tables/jane.other.t',
			qualifiedReference: 'jane.other.t',
		},
		'PATCH /tables/jane.other.t': { name: 'u', uri: '/tables/jane.other.u', qualifiedReference: 'jane.other.u' },
		'PATCH /tables/jane.other.u/variables/x': { name: 'x', label: 'X' },
		'GET /tables/jane.other.u/variables/x/statistics': (() => {
			let polls = 0;
			return () => ({ status: polls++ ? 'completed' : 'running', count: 10 });
		})(),
	});
	const created = await redivis.table('demo.ds.t').create({ isFileIndex: true });
	assert.equal(created.workflow, undefined);
	assert.deepEqual(requests.at(-1).body, { name: 't', uploadMergeStrategy: 'append', isFileIndex: true });

	// A table addressed within a workflow may come from one of its datasources, so it's resolved before writing
	const table = redivis.workflow('jane.wf').table('t');
	await table.update({ name: 'u' });
	assert.deepEqual(
		requests.slice(-2).map(({ method, path }) => `${method} ${path}`),
		['GET /workflows/jane.wf/tables/t', 'PATCH /tables/jane.other.t'],
	);
	const variable = table.variable('x');
	await variable.update({ label: 'X' });
	assert.equal(requests.at(-1).path, '/tables/jane.other.u/variables/x');
	assert.equal((await variable.getStatistics()).count, 10);

	await assert.rejects(redivis.user('jane').workflow('wf').table('t2').create(), /Only tables in a dataset/);
});

test('parameters can be created, updated, and read', async () => {
	const requests = mockRoutes({
		'POST /workflows/jane.wf/parameters': ({ body }) => ({ uri: '/workflows/jane.wf/parameters/p', ...body }),
		'GET /workflows/jane.wf/parameters/p': { uri: '/workflows/jane.wf/parameters/p', name: 'p', values: [1, 2] },
		'PATCH /workflows/jane.wf/parameters/p': ({ body }) => ({ uri: '/workflows/jane.wf/parameters/p', ...body }),
		'DELETE /workflows/jane.wf/parameters/p': {},
	});
	const parameter = redivis.parameter('jane.wf.p');
	await parameter.create({ values: [1, 2] });
	assert.deepEqual(requests[0].body, { name: 'p', values: [1, 2] });
	assert.deepEqual(await parameter.getValues(), [1, 2]);
	await parameter.update({ name: 'q' });
	assert.equal(parameter.name, 'q');
	await parameter.delete();
});

test('transforms are created from a table, and run until their job finishes', async () => {
	let status = 'running';
	const requests = mockRoutes({
		'POST /workflows/jane.wf/transforms': ({ body }) => ({
			name: 'transform_1',
			uri: '/transforms/x',
			qualifiedReference: 'jane.wf.transform_1',
			...body,
		}),
		'POST /transforms/x/run': { uri: '/transforms/x', currentJob: { id: 'j2', status: 'queued' } },
		'GET /transforms/x': () => ({
			uri: '/transforms/x',
			// The most recent job isn't the one we started, until it finishes
			currentJob: status === 'running' ? { id: 'j2', status } : null,
			lastRunJob:
				status === 'running' ? { id: 'j1', status: 'completed' } : { id: 'j2', status, kind: 'transform' },
			outputTable: { qualifiedReference: 'jane.wf.out', uri: '/tables/out' },
		}),
		'POST /transforms/x/cancel': { uri: '/transforms/x' },
		'DELETE /transforms/x': new Response(null, { status: 204 }),
	});
	const transform = redivis.workflow('jane.wf').transform();
	await transform.create({ sourceTable: redivis.table('demo.ds.t'), query: 'SELECT 1' });
	assert.equal(transform.name, 'transform_1');
	assert.deepEqual(requests[0].body, { sourceTable: 'demo.ds.t', query: 'SELECT 1' });

	setTimeout(() => (status = 'completed'), 2500);
	await transform.run();
	assert.equal((await transform.outputTable()).uri, '/tables/out');

	status = 'running';
	setTimeout(() => (status = 'failed'), 2500);
	await assert.rejects(transform.run(), (e) => e instanceof JobError && e.status === 'failed');

	await transform.run({ waitForFinish: false });
	assert.equal(await transform.cancel(), transform);

	await transform.delete();
	assert.equal(`${requests.at(-1).method} ${requests.at(-1).path}`, 'DELETE /transforms/x');
});

test('rejects workflow children without a workflow', () => {
	assert.throws(() => redivis.parameter('p'), ValueError);
	assert.throws(() => redivis.transform('t'), ValueError);
	assert.throws(() => redivis.notebook('n'), ValueError);
	assert.throws(() => redivis.datasource('demo.ds'), ValueError);
	assert.equal(redivis.notebook('n', { workflow: 'jane.wf' }).uri, '/notebooks/jane.wf.n');
});

test('users exist if their datasets can be listed, since there is no endpoint to get a user', async () => {
	const requests = mockRoutes({
		'GET /users/jane/datasets?maxResults=1': { results: [] },
		'GET /users/nobody/datasets?maxResults=1': jsonResponse({ error: 'not_found' }, { status: 404 }),
	});

	assert.equal(await redivis.user('jane').exists(), true);
	assert.equal(await redivis.user('nobody').exists(), false);
	assert.ok(requests.every(({ method }) => method === 'GET'));
});
