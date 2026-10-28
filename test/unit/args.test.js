import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../src/common/args.js';
import { ValueError } from '../../src/common/errors.js';

const spec = [['maxResults'], { defaults: { progress: true }, allowed: ['variables'] }];

test('positional arguments and options are interchangeable', () => {
	assert.deepEqual(parseArgs([10, { variables: ['a'] }], ...spec), {
		maxResults: 10,
		variables: ['a'],
		progress: true,
	});
	assert.deepEqual(parseArgs([{ maxResults: 10, variables: ['a'] }], ...spec), {
		maxResults: 10,
		variables: ['a'],
		progress: true,
	});
});

test('defaults apply only to unset options', () => {
	assert.deepEqual(parseArgs([], ...spec), { progress: true });
	assert.deepEqual(parseArgs([{ progress: false }], ...spec), { progress: false });
	assert.deepEqual(parseArgs([undefined, { progress: undefined }], ...spec), { progress: true });
});

test('trailing undefined arguments are ignored', () => {
	assert.deepEqual(parseArgs([10, undefined], ...spec), { maxResults: 10, progress: true });
});

test('arrays and class instances are positional, not options', () => {
	assert.deepEqual(parseArgs([['a', 'b']], ['rows']), { rows: ['a', 'b'] });
	const blob = new Blob(['x']);
	assert.equal(parseArgs([blob], ['content']).content, blob);
});

test('the caller passing the input object does not have it mutated', () => {
	const options = { variables: ['a'] };
	parseArgs([10, options], ...spec);
	assert.deepEqual(options, { variables: ['a'] });
});

test('rejects invalid arguments', () => {
	assert.throws(() => parseArgs([1, 2], ...spec), ValueError);
	assert.throws(() => parseArgs([{ maxResult: 1 }], ...spec), /Unknown option "maxResult"/);
	assert.throws(() => parseArgs([1, { maxResults: 2 }], ...spec), /both as an argument and as an option/);
	// The same value both ways is harmless
	assert.deepEqual(parseArgs([1, { maxResults: 1 }], ...spec).maxResults, 1);
});
