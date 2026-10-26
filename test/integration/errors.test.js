// How errors from the API surface to callers.
import { createTable, owner, sample, skip, uniqueName } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';

const { APIError, NotFoundError, RedivisError, ValueError } = redivis.errors;

describe('errors', { skip }, () => {
	test('a missing dataset', async () => {
		const dataset = owner.dataset(uniqueName('missing'));

		assert.equal(await dataset.exists(), false);
		await assert.rejects(dataset.get(), (error) => {
			assert.ok(error instanceof NotFoundError);
			assert.ok(error instanceof APIError);
			assert.ok(error instanceof RedivisError);
			assert.equal(error.status, 404);
			assert.equal(error.code, 'not_found');
			return true;
		});
	});

	test('a missing table', async () => {
		const table = (await sample.tiny()).dataset.table('does_not_exist');

		assert.equal(await table.exists(), false);
		await assert.rejects(table.get(), NotFoundError);
	});

	test('a missing variable', async () => {
		const variable = (await sample.tiny()).variable('does_not_exist');

		assert.equal(await variable.exists(), false);
		await assert.rejects(variable.get(), NotFoundError);
	});

	test('an unknown endpoint has a readable error', async () => {
		await assert.rejects(redivis.makeApiRequest({ method: 'GET', path: '/not_an_endpoint' }), (error) => {
			assert.ok(error instanceof NotFoundError);
			assert.match(error.message, /Invalid API endpoint/);
			assert.match(String(error), /Invalid API endpoint/);
			return true;
		});
	});

	test('an invalid request throws an APIError', async (t) => {
		const table = await createTable(t);

		await assert.rejects(table.update({ name: '' }), (error) => {
			assert.ok(error instanceof APIError);
			assert.ok(error.status >= 400 && error.status < 500, `status ${error.status}`);
			assert.ok(error.description);
			return true;
		});
	});

	test('invalid arguments throw a ValueError before any request', async () => {
		const table = await sample.tiny();

		assert.throws(() => table.toArrowBatchIterator({ maxResults: -1 }), ValueError);
		await assert.rejects(table.toRowsArray({ notAnOption: true }), ValueError);
		await assert.rejects(table.toReadStreams(0), ValueError);
	});
});
