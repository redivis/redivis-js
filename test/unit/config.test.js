import './helpers.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/common/config.js';
import { ValueError } from '../../src/common/errors.js';
import { getDefaultParallelization } from '../../src/common/readRows.js';

afterEach(() => {
	delete process.env.REDIVIS_DEFAULT_WORKFLOW;
	config({ defaultWorkflow: null, defaultDataset: null });
});

test('falls back to environment variables', () => {
	assert.equal(config().defaultWorkflow, undefined);
	process.env.REDIVIS_DEFAULT_WORKFLOW = 'jane.from_env';
	assert.equal(config().defaultWorkflow, 'jane.from_env');
});

test('set values take precedence, until cleared with null', () => {
	process.env.REDIVIS_DEFAULT_WORKFLOW = 'jane.from_env';
	assert.equal(config({ defaultWorkflow: 'jane.from_config' }).defaultWorkflow, 'jane.from_config');
	// undefined leaves a value as it is
	assert.equal(config({ defaultWorkflow: undefined }).defaultWorkflow, 'jane.from_config');
	assert.equal(config({ defaultWorkflow: null }).defaultWorkflow, 'jane.from_env');
});

test('rejects unknown options', () => {
	assert.throws(() => config({ defaultTable: 'x' }), ValueError);
	assert.throws(() => config('jane.wf'), ValueError);
});

test('validates values before setting any of them', () => {
	assert.throws(() => config({ maxParallelization: 0 }), ValueError);
	assert.throws(() => config({ maxParallelization: 2.5 }), ValueError);
	assert.throws(() => config({ apiEndpoint: 'redivis.com' }), ValueError);
	assert.throws(() => config({ defaultWorkflow: 'jane.wf', defaultDataset: 12 }), ValueError);
	assert.equal(config().defaultWorkflow, undefined);
});

test('accepts Redivis objects as references', () => {
	assert.equal(config({ defaultWorkflow: { qualifiedReference: 'jane.wf:abc1' } }).defaultWorkflow, 'jane.wf:abc1');
});

test('parses environment variables', () => {
	process.env.REDIVIS_MAX_PARALLELIZATION = '4';
	try {
		assert.equal(config().maxParallelization, 4);
		process.env.REDIVIS_MAX_PARALLELIZATION = 'many';
		assert.throws(() => config(), /REDIVIS_MAX_PARALLELIZATION must be a positive integer/);
	} finally {
		delete process.env.REDIVIS_MAX_PARALLELIZATION;
	}
});

test('apiEndpoint falls back to its default, and drops trailing slashes', () => {
	const envEndpoint = process.env.REDIVIS_API_ENDPOINT;
	delete process.env.REDIVIS_API_ENDPOINT;
	try {
		assert.equal(config().apiEndpoint, 'https://redivis.com/api/v1');
		assert.equal(
			config({ apiEndpoint: 'https://example.test/api/v1/' }).apiEndpoint,
			'https://example.test/api/v1',
		);
	} finally {
		config({ apiEndpoint: null });
		process.env.REDIVIS_API_ENDPOINT = envEndpoint;
	}
});

test('maxParallelization sets the default for parallel methods', () => {
	assert.equal(getDefaultParallelization(), Math.min(8, navigator.hardwareConcurrency || 4));
	config({ maxParallelization: 3 });
	try {
		assert.equal(getDefaultParallelization(), 3);
	} finally {
		config({ maxParallelization: null });
	}
});
