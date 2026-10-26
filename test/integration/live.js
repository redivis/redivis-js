// The live environment that the integration tests run against, and fixtures for creating (and cleaning up) what they
//   need. Import this before anything else in an integration test.
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import redivis from '../../index.js';
import { applySettings } from './environment.js';
import { deleteDataset } from './setup.js';

// Normally the global setup has already run. Without it (e.g., `node --test test/integration/files.test.js`), this
//   file gets a run of its own.
if (!process.env.REDIVIS_TEST_RUN) {
	const { globalSetup, globalTeardown } = await import('./setup.js');
	await globalSetup();
	after(globalTeardown);
}

const run = JSON.parse(process.env.REDIVIS_TEST_RUN);
export const settings = applySettings(run.settings);

/** Why the integration tests are skipped, if they are; pass as the `skip` option of each suite. */
export const skip = run.skip ?? false;

/** The authenticated user */
export const user = run.user && redivis.user(run.user);

/** The user or organization that owns the datasets the tests create */
export const owner = run.owner && redivis[run.owner.kind](run.owner.name);

/** The qualified reference of the dataset of sample data (see setup.js) */
export const sampleDatasetReference = run.sampleDataset;

// Uploads and other jobs normally finish in well under a minute
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * A name that's unique to this run, and marks a resource as the tests'.
 * @param {string} [label]
 */
export function uniqueName(label = '') {
	return `${run.runId}_${label ? `${label}_` : ''}${randomBytes(3).toString('hex')}`;
}

/**
 * Creates a dataset that's deleted once the test finishes.
 *
 * @param {import('node:test').TestContext} t
 * @param {{label?: string, description?: string, publicAccessLevel?: string}} [options]
 */
export async function createDataset(t, { label = '', ...options } = {}) {
	const dataset = owner.dataset(uniqueName(label));
	t.after(() => cleanUp(() => deleteDataset(dataset)));
	return dataset.create(options);
}

/**
 * Creates a workflow that's deleted once the test finishes.
 *
 * @param {import('node:test').TestContext} t
 * @param {{label?: string, description?: string, isPublic?: boolean}} [options]
 */
export async function createWorkflow(t, { label = 'workflow', ...options } = {}) {
	const workflow = owner.workflow(uniqueName(label));
	t.after(() => cleanUp(() => workflow.delete()));
	return workflow.create(options);
}

let scratchDataset;

/**
 * Creates a table, in a dataset shared by the test file, that's deleted once the test finishes.
 *
 * @param {import('node:test').TestContext} t
 * @param {{label?: string, description?: string, uploadMergeStrategy?: 'append' | 'replace', isFileIndex?: boolean}} [options]
 */
export async function createTable(t, { label = 'table', ...options } = {}) {
	scratchDataset ??= owner.dataset(uniqueName('scratch')).create();
	const table = (await scratchDataset).table(uniqueName(label));
	t.after(() => cleanUp(() => table.delete()));
	return table.create(options);
}

after(async () => {
	if (scratchDataset) {
		await cleanUp(async () => deleteDataset(await scratchDataset));
	}
});

/**
 * Deletes something the tests created (unless REDIVIS_TEST_KEEP_RESOURCES is set), warning rather than throwing if that
 * fails.
 * @param {() => Promise<any>} fn
 */
export async function cleanUp(fn) {
	if (settings.keepResources) {
		return;
	}
	try {
		await fn();
	} catch (e) {
		if (!(e instanceof redivis.errors.NotFoundError)) {
			console.warn(`Cleanup failed: ${e.message}`);
		}
	}
}

/**
 * Waits for an upload started with `waitForFinish: false`, throwing if it fails.
 * @param {import('../../src/classes/Upload.js').default} upload
 */
export async function waitForUpload(upload, { timeout = JOB_TIMEOUT_MS } = {}) {
	const deadline = Date.now() + timeout;
	while (true) {
		const { status, errorMessage } = (await upload.get()).properties;
		if (status === 'completed') {
			return upload;
		} else if (status === 'failed') {
			throw new redivis.errors.JobError({ kind: 'upload', status, message: errorMessage });
		} else if (Date.now() > deadline) {
			throw new Error(`${upload} didn't finish within ${timeout / 1000}s (${status})`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

const sampleTables = new Map();

function sampleTable(name, uploadName) {
	if (!sampleTables.has(name)) {
		const table = redivis.dataset(sampleDatasetReference).table(name);
		sampleTables.set(
			name,
			(async () => {
				if (uploadName) {
					await waitForUpload(table.upload(uploadName));
				}
				return table.get();
			})(),
		);
	}
	return sampleTables.get(name);
}

/**
 * The tables of the sample dataset, once their data has been imported. See data.js for their contents.
 */
export const sample = {
	dataset: () => redivis.dataset(sampleDatasetReference).get(),
	/** tiny.csv, uploaded as a CSV file */
	tiny: () => sampleTable('tiny', 'tiny.csv'),
	/** typedRows(), uploaded as an array of rows (i.e., newline-delimited JSON) */
	typed: () => sampleTable('typed', 'typed'),
	/** GEO_FEATURES, uploaded as GeoJSON */
	geo: () => sampleTable('geo', 'features.geojson'),
	/** A file index table of rawFiles() */
	files: () => sampleTable('files'),
};
