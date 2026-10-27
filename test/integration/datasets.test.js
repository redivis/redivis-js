// Creating, updating, versioning, and deleting datasets.
import { createDataset, owner, skip, uniqueName } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';
import Table from '../../src/classes/Table.js';
import Version from '../../src/classes/Version.js';
import { addData } from './helpers.js';

const { ValueError } = redivis.errors;

// Each test creates its own datasets, so they can run concurrently
describe('datasets', { skip, concurrency: true }, () => {
	test('create', async (t) => {
		const dataset = await createDataset(t, { description: 'A description' });

		assert.equal(await dataset.exists(), true);
		assert.equal(dataset.properties.description, 'A description');
		assert.equal(dataset.properties.publicAccessLevel, 'none');
		assert.ok(dataset.qualifiedReference.startsWith(`${owner.name}.`));
		// A new dataset starts out with an unreleased version, which it references
		assert.equal(dataset.versionTag, 'next');
		assert.equal(dataset.properties.version.isReleased, false);
		// The owner is known once the dataset is created
		assert.equal((dataset.organization || dataset.user).name, owner.name);
	});

	test('get by qualified reference', async (t) => {
		const dataset = await createDataset(t);

		const fetched = await redivis.dataset(dataset.qualifiedReference).get();

		assert.equal(fetched.properties.id, dataset.properties.id);
		assert.equal(fetched.name, dataset.name);
		// Whether the owner is a user or an organization is resolved from the fetched properties
		assert.equal(fetched.properties.owner.kind, owner.properties.kind);
		assert.equal(fetched.organization ? 'organization' : 'user', owner.properties.kind);
	});

	test('get by owner and name', async (t) => {
		const dataset = await createDataset(t);

		const fetched = await owner.dataset(dataset.name, { version: 'next' }).get();

		assert.equal(fetched.properties.id, dataset.properties.id);
	});

	test('update', async (t) => {
		const dataset = await createDataset(t);

		await dataset.update({
			description: 'Updated',
			methodologyMarkdown: '# Methodology',
			usageMarkdown: 'Usage notes',
			labelsToAdd: ['jstest', 'other'],
		});
		assert.equal(dataset.properties.description, 'Updated');
		assert.equal(dataset.properties.methodologyMarkdown, '# Methodology');
		assert.equal(dataset.properties.usageMarkdown, 'Usage notes');
		assert.deepEqual([...dataset.properties.labels].sort(), ['jstest', 'other']);

		await dataset.update({ labelsToRemove: ['other'] });
		assert.deepEqual(dataset.properties.labels, ['jstest']);

		// Re-fetching reflects what was saved
		assert.equal((await dataset.get()).properties.description, 'Updated');
	});

	test('rename', async (t) => {
		const dataset = await createDataset(t);
		const newName = `${dataset.name}_renamed`;

		await dataset.update({ name: newName });

		assert.equal(dataset.name, newName);
		assert.ok(dataset.qualifiedReference.includes(newName));
		assert.equal((await dataset.get()).name, newName);
	});

	test('delete', async () => {
		const dataset = await owner.dataset(uniqueName('delete')).create();
		assert.equal(await dataset.exists(), true);

		await dataset.delete();

		assert.equal(await dataset.exists(), false);
	});

	test('createNextVersion() when one exists', async (t) => {
		const dataset = await createDataset(t);

		await assert.rejects(dataset.createNextVersion(), (error) => {
			assert.ok(error instanceof ValueError);
			assert.match(error.message, /already exists/);
			return true;
		});

		const nextVersion = await dataset.createNextVersion({ ifNotExists: true });
		assert.equal(nextVersion.versionTag, 'next');
		assert.equal(nextVersion.properties.id, dataset.properties.id);
	});

	test('release, and version history', async (t) => {
		const dataset = await createDataset(t);
		await addData(dataset);

		// The next version can't be released until this one has finished being released
		await dataset.release({ releaseNotes: 'First release', waitForFinalization: true });

		assert.equal(dataset.versionTag, 'v1_0');
		assert.equal(dataset.properties.version.isReleased, true);
		const version = await (await dataset.version()).get();
		assert.ok(version instanceof Version);
		assert.equal(version.properties.tag, 'v1.0');
		assert.equal(version.properties.releaseNotes, 'First release');
		assert.equal(version.properties.isFinalizing, false);
		assert.equal(await dataset.previousVersion(), null);

		const nextVersion = await dataset.createNextVersion();
		assert.equal(nextVersion.versionTag, 'next');
		// A version can only be released if it changed something
		await addData(nextVersion, 'more_data');
		await nextVersion.release({ waitForFinalization: true });
		const secondTag = nextVersion.properties.version.tag;
		assert.notEqual(secondTag, 'v1.0');
		assert.equal(nextVersion.versionTag, secondTag.replace('.', '_'));

		const tags = (await nextVersion.listVersions()).map((v) => v.properties.tag);
		assert.deepEqual(tags.sort(), ['v1.0', secondTag].sort());
		assert.equal((await nextVersion.previousVersion()).versionTag, 'v1_0');
		assert.equal((await (await nextVersion.previousVersion()).nextVersion()).versionTag, nextVersion.versionTag);

		// The released versions remain readable by their tags, in either form
		const unversioned = dataset.qualifiedReference.replace(/:v\d+_\d+$/, '');
		assert.equal(await redivis.dataset(`${unversioned}:v1.0`).exists(), true);
		assert.equal(await redivis.dataset(`${unversioned}:v1_0`).exists(), true);
		const original = await redivis.dataset(`${unversioned}:v1_0`).listTables();
		assert.deepEqual(
			original.map((table) => table.name),
			['data'],
		);

		// A historic version's data is removed in the background
		const firstVersion = (await nextVersion.listVersions()).find((version) => version.properties.tag === 'v1.0');
		await firstVersion.delete({ waitForFinalization: true });
		assert.equal(firstVersion.properties.isDeleted, true);
		assert.equal(firstVersion.properties.isFinalizing, false);
	});

	test('unrelease', async (t) => {
		const dataset = await createDataset(t);
		await addData(dataset);
		// A version can't be unreleased until its release finishes
		await dataset.release({ waitForFinalization: true });

		await dataset.unrelease({ waitForFinalization: true });
		assert.equal(dataset.versionTag, 'next');
		assert.equal(dataset.properties.version.isReleased, false);
		const version = await (await dataset.version()).get();
		assert.equal(version.properties.isFinalizing, false);
	});

	test('version update', async (t) => {
		const dataset = await createDataset(t);
		await addData(dataset);
		await dataset.release();

		const version = await (await dataset.version()).update({ label: 'Initial', releaseNotes: 'Notes' });

		assert.equal(version.properties.label, 'Initial');
		assert.equal((await version.get()).properties.releaseNotes, 'Notes');
	});

	test('list tables', async (t) => {
		const dataset = await createDataset(t);
		await dataset.table('first').create();
		await dataset.table('second').create({ isFileIndex: true });

		const tables = await dataset.listTables();

		assert.deepEqual(tables.map((table) => table.name).sort(), ['first', 'second']);
		assert.ok(tables.every((table) => table instanceof Table && table.dataset === dataset));
		assert.equal((await dataset.listTables(1)).length, 1);
	});

	test('update variables across tables', async (t) => {
		const dataset = await createDataset(t);
		const table = await addData(dataset);

		await dataset.updateVariables([{ tableName: table.name, name: 'a', label: 'The a variable' }]);

		assert.equal((await table.variable('a').get()).properties.label, 'The a variable');
	});
});
