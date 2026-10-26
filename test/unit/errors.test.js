import { test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import {
	APIError,
	AuthorizationError,
	JobError,
	NetworkError,
	NotFoundError,
	RedivisError,
	ValueError,
	createApiError,
} from '../../src/common/errors.js';

test('errors are exported, and share a base class', () => {
	assert.equal(redivis.errors.NotFoundError, NotFoundError);
	for (const ErrorClass of [APIError, AuthorizationError, JobError, NetworkError, NotFoundError, ValueError]) {
		const error = new ErrorClass();
		assert.ok(error instanceof RedivisError);
		assert.ok(error instanceof Error);
		assert.equal(error.name, ErrorClass.name);
	}
});

test('API errors are mapped by status', () => {
	const notFound = createApiError(404, { error: 'not_found', error_description: 'No such table' });
	assert.ok(notFound instanceof NotFoundError);
	assert.equal(notFound.message, 'No such table');
	assert.equal(notFound.status, 404);
	assert.equal(notFound.code, 'not_found');

	const forbidden = createApiError(403, { error: 'forbidden', error_description: 'Nope' });
	assert.ok(forbidden instanceof AuthorizationError);
	assert.equal(forbidden.message, '[403 forbidden] Nope');

	const invalid = createApiError(400, { error: 'invalid_request', error_description: 'Bad name' });
	assert.equal(invalid.constructor, APIError);
	assert.equal(invalid.description, 'Bad name');
});

test('API errors are read from nested, text, and empty bodies', () => {
	const nested = createApiError(400, { error: { code: 400, status: 'INVALID', message: 'Nested' } });
	assert.equal(nested.code, 400);
	assert.equal(nested.description, 'Nested');

	const text = createApiError(502, 'Bad gateway');
	assert.equal(text.code, 'api_error');
	assert.equal(text.message, '[502 api_error] Bad gateway');

	assert.equal(createApiError(500, '').message, '[500 api_error]');
	assert.equal(createApiError(404, null).message, 'api_error');
});

test('job errors describe the job', () => {
	assert.equal(
		new JobError({ kind: 'query', status: 'failed', message: 'Syntax error' }).message,
		'[query failed] Syntax error',
	);
	assert.equal(new JobError({ status: 'cancelled' }).message, 'Job finished with status: cancelled');
});

test('network errors include their cause', () => {
	const cause = new TypeError('fetch failed');
	const error = new NetworkError('GET /x failed', { cause });

	assert.equal(error.message, 'GET /x failed: fetch failed');
	assert.equal(error.cause, cause);
});
