// Global setup for the integration tests (see `--test-global-setup` in package.json), which runs once, before any test
//   file. It checks that the environment is reachable, logs in if need be, and starts uploading the sample data that
//   tests read. What it learns is passed to the test files (each run in a process of its own) as REDIVIS_TEST_RUN.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import redivis from '../../index.js';
import { applySettings, getSettings } from './environment.js';
import { TINY_CSV, geojsonBytes, rawFiles, typedRows, writeFiles } from './data.js';
import { retryWhileReleasing } from './helpers.js';

// Everything the tests create is named with this prefix, which marks it as theirs
export const RESOURCE_PREFIX = 'jstest_';
// Datasets from an earlier run that are older than this are assumed to be abandoned
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

let sampleDataset;
let filesDirectory;

export async function globalSetup() {
	const settings = applySettings();
	const run = { settings, runId: newRunId() };
	const publish = () => (process.env.REDIVIS_TEST_RUN = JSON.stringify(run));

	const unreachable = await checkReachable(settings.apiEndpoint);
	if (unreachable) {
		run.skip = `The Redivis API at ${settings.apiEndpoint} is unreachable (${unreachable})`;
		console.warn(`${run.skip}; skipping the integration tests`);
		return publish();
	}
	if (!(await redivis.isAuthorized()) && process.env.CI) {
		throw new Error(
			'No Redivis credentials are available. Set REDIVIS_API_TOKEN to run the integration tests non-interactively.',
		);
	}

	// Logs in, if there are no credentials yet
	const user = await redivis.currentUser();
	const owner = await resolveOwner(settings.owner, user);
	run.user = user.name;
	run.owner = { name: owner.name, kind: owner.properties.kind };
	console.log(
		`Testing against ${settings.apiEndpoint} as ${user.name}, creating datasets named ${run.runId}_* in ${owner.name}` +
			` (credentials in ${settings.configDir})`,
	);

	await deleteStaleResources(owner);
	try {
		run.sampleDataset = await createSampleDataset(owner, run.runId);
	} catch (e) {
		// The teardown doesn't run when the setup fails
		await globalTeardown();
		throw e;
	}
	publish();
}

export async function globalTeardown() {
	if (sampleDataset && !getSettings().keepResources) {
		await deleteDataset(sampleDataset).catch((e) => console.warn(`Couldn't delete ${sampleDataset}: ${e.message}`));
	}
	if (filesDirectory) {
		await rm(filesDirectory, { recursive: true, force: true });
	}
}

function newRunId() {
	const now = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
	return `${RESOURCE_PREFIX}${now.slice(0, 8)}_${now.slice(8)}_${randomBytes(2).toString('hex')}`;
}

// Returns why the API can't be reached, if it can't
async function checkReachable(apiEndpoint) {
	try {
		const response = await fetch(apiEndpoint, { signal: AbortSignal.timeout(10_000) });
		await response.body?.cancel();
		return null;
	} catch (e) {
		return e.cause?.code || e.cause?.message || e.message;
	}
}

async function resolveOwner(name, user) {
	if (!name || name === user.name) {
		return user;
	}
	const organization = redivis.organization(name);
	return (await organization.exists()) ? organization : redivis.user(name);
}

async function deleteStaleResources(owner) {
	const isStale = ({ name, properties }) =>
		name.startsWith(RESOURCE_PREFIX) && Date.now() - properties.createdAt > STALE_AFTER_MS;
	for (const dataset of (await owner.listDatasets()).filter(isStale)) {
		await deleteDataset(dataset).catch((e) => console.warn(`Couldn't delete stale ${dataset}: ${e.message}`));
	}
	for (const workflow of (await owner.listWorkflows()).filter(isStale)) {
		await workflow.delete().catch((e) => console.warn(`Couldn't delete stale ${workflow}: ${e.message}`));
	}
}

/**
 * Deletes a dataset (as a whole, rather than whichever version it references), waiting out a release that's still in
 * progress.
 */
export async function deleteDataset(dataset) {
	const reference = dataset.qualifiedReference.replace(/:(v\d+_\d+|next|current)$/, '');
	try {
		await retryWhileReleasing(() => redivis.dataset(reference).delete());
	} catch (e) {
		if (!(e instanceof redivis.errors.NotFoundError)) {
			throw e;
		}
	}
}

/**
 * Creates a dataset of tables with known contents, for tests to read (see data.js). Uploads are started here, and
 * waited for by the tests that read them, so that they're processed concurrently.
 */
async function createSampleDataset(owner, runId) {
	sampleDataset = await owner.dataset(`${runId}_sample`).create({ description: 'Sample data for tests' });

	const [tiny, typed, geo, files] = await Promise.all([
		sampleDataset.table('tiny').create({ description: 'tiny.csv' }),
		sampleDataset.table('typed').create(),
		sampleDataset.table('geo').create(),
		sampleDataset.table('files').create({ isFileIndex: true }),
	]);
	filesDirectory = await writeFiles(await mkdtemp(join(tmpdir(), 'redivis-test-files-')), rawFiles());

	await Promise.all([
		tiny.upload('tiny.csv').create(TINY_CSV, { waitForFinish: false }),
		typed.upload('typed').create(typedRows(), { waitForFinish: false }),
		geo.upload('features.geojson').create(geojsonBytes(), { type: 'geojson', waitForFinish: false }),
		files.addFiles({ directory: filesDirectory }),
	]);
	return sampleDataset.qualifiedReference;
}
