// The authenticated user, and listing what users own.
import { createDataset, owner, skip, user } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import Dataset from '../../src/classes/Dataset.js';
import User from '../../src/classes/User.js';
import Workflow from '../../src/classes/Workflow.js';
import { addData } from './helpers.js';

describe('users', { skip }, () => {
	test('currentUser() is the authenticated user', async () => {
		const current = await redivis.currentUser();

		assert.ok(current instanceof User);
		assert.equal(current.name, user.name);
		assert.equal(current.properties.kind, 'user');
		assert.equal(current.uri, `/users/${current.name}`);
	});

	test('isAuthorized() reports the credentials in use', async () => {
		assert.equal(await redivis.isAuthorized(), true);
	});

	test('users exist, and missing ones do not', async () => {
		assert.equal(await user.exists(), true);
		assert.equal(await redivis.user(`no_such_user_${Date.now()}`).exists(), false);
	});

	test('lists datasets', async () => {
		const datasets = await user.listDatasets(3);

		assert.ok(datasets.length <= 3);
		for (const dataset of datasets) {
			assert.ok(dataset instanceof Dataset);
			assert.equal(dataset.properties.kind, 'dataset');
			assert.ok(dataset.qualifiedReference.startsWith(`${user.name}.`));
		}
	});

	test('lists workflows', async () => {
		const workflows = await user.listWorkflows({ maxResults: 3 });

		assert.ok(workflows.length <= 3);
		for (const workflow of workflows) {
			assert.ok(workflow instanceof Workflow);
			assert.ok(workflow.qualifiedReference.startsWith(`${user.name}.`));
		}
	});

	test('the owner lists the datasets it owns', async (t) => {
		const dataset = await createDataset(t);
		await addData(dataset);
		// Unreleased datasets aren't listed
		await dataset.release();

		const listed = (await owner.listDatasets()).map((d) => d.properties.id);

		assert.ok(listed.includes(dataset.properties.id));
	});
});
