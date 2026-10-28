// Organizations, and the datasets and members they have. These need an organization that the test user belongs to,
//   from REDIVIS_TEST_ORGANIZATION (or the environment's default).
import { createDataset, owner, settings, skip, uniqueName, user } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import redivis from '../../index.js';
import Member from '../../src/classes/Member.js';
import { addData } from './helpers.js';

const organization = settings.organization && redivis.organization(settings.organization);

const skipOrganization = skip || (!organization && 'needs an organization; set REDIVIS_TEST_ORGANIZATION');

describe('organizations', { skip: skipOrganization }, () => {
	test('exists', async () => {
		assert.equal(await organization.exists(), true);
		assert.equal(await redivis.organization(uniqueName('missing')).exists(), false);
	});

	test('list datasets', async () => {
		const datasets = await organization.listDatasets(5);

		assert.ok(datasets.length <= 5);
		for (const dataset of datasets) {
			assert.equal(dataset.organization.name, organization.name);
			assert.equal(dataset.properties.owner.kind, 'organization');
		}
	});

	test('list datasets by label', async (t) => {
		if (owner.name !== organization.name) {
			return t.skip('needs the test datasets to be owned by the organization');
		}
		// Labels may only have letters, numbers, and underscores
		const label = `jstest_${randomBytes(4).toString('hex')}`;
		const dataset = await createDataset(t);
		await dataset.update({ labels: [label] });
		await addData(dataset);
		// Unreleased datasets aren't listed
		await dataset.release();

		const listed = await organization.listDatasets({ labels: [label] });

		assert.deepEqual(
			listed.map((d) => d.properties.id),
			[dataset.properties.id],
		);
	});

	test('list members', async () => {
		const members = await organization.listMembers();

		assert.ok(members.length > 0);
		assert.ok(members.every((member) => member instanceof Member));
		assert.ok(members.map((member) => member.name).includes(user.name));
	});

	test('get a member', async () => {
		const member = organization.member(user.name);

		assert.equal(await member.exists(), true);
		await member.get();
		assert.equal(member.user.name, user.name);
		assert.equal(member.properties.user.name, user.name);
		assert.equal(member.user.properties.name, user.name);
	});

	test('list workflows', async () => {
		for (const workflow of await organization.listWorkflows(3)) {
			assert.equal(workflow.organization.name, organization.name);
		}
	});
});
