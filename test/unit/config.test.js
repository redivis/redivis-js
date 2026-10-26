import './helpers.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/common/config.js';
import { ValueError } from '../../src/common/errors.js';

afterEach(() => {
	delete process.env.REDIVIS_DEFAULT_WORKFLOW;
	config({ defaultWorkflow: null });
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
