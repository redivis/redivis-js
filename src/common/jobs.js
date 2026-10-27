import { sleep } from './apiRequest.js';
import { JobError } from './errors.js';

const FINISHED_STATUSES = ['completed', 'failed', 'cancelled'];

// Waits for a run of a transform or notebook to finish, given the response to starting it. Throws a JobError if the
//   run didn't complete.
export async function waitForRun(instance, runProperties, { signal } = {}) {
	const jobId = runProperties?.currentJob?.id;
	while (true) {
		await sleep(2000, signal);
		await instance.get();
		const { currentJob, lastRunJob } = instance.properties;
		// Track the job that this run started, rather than whichever is most recent, where the API told us which it is
		const job = jobId ? [currentJob, lastRunJob].find((j) => j?.id === jobId) : currentJob || lastRunJob;
		if (job && FINISHED_STATUSES.includes(job.status)) {
			if (job.status !== 'completed') {
				throw new JobError({ message: job.errorMessage, status: job.status, kind: job.kind });
			}
			return;
		}
	}
}

// Waits for a version's release, unrelease, or deletion to be finalized, given the version as returned by that request.
//   These take effect immediately, but the version's data is moved in the background, and the dataset can't be released,
//   unreleased, or deleted again until that finishes.
export async function waitForVersionFinalization(version, { signal } = {}) {
	while (version.properties?.isFinalizing) {
		await sleep(2000, signal);
		await version.get();
	}
}
