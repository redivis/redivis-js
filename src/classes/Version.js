import Base from './Base.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { waitForVersionFinalization } from '../common/jobs.js';
import { definedValues } from '../common/references.js';
import Dataset, { normalizeVersionTag } from './Dataset.js';

export default class Version extends Base {
	#dataset;

	/**
	 * A version of a dataset.
	 *
	 * @param {[tag: string, options: {dataset: Dataset, properties?: Record<string, any>}] | [options: {tag: string, dataset: Dataset, properties?: Record<string, any>}]} args
	 *   The version tag, e.g. `v1_0`, `current`, or `next`
	 */
	constructor(...args) {
		super();
		const { tag, dataset, properties } = parseArgs(args, ['tag'], { allowed: ['dataset', 'properties'] });
		/** @type {string} */
		this.tag = normalizeVersionTag(tag);
		this.#dataset = dataset;
		this.uri = properties?.uri ?? `${dataset.uri}/versions/${encodeURIComponent(this.tag)}`;
		this.properties = properties;
	}

	toString() {
		const datasetReference = this.#dataset.qualifiedReference.replace(/:(v\d+[._]\d+|current|next)$/i, '');
		return `<Version ${datasetReference}:${this.tag}>`;
	}

	/**
	 * Returns the dataset at this version.
	 * @returns {Dataset}
	 */
	dataset() {
		return new Dataset(this.#dataset.scopedReference, {
			user: this.#dataset.user,
			organization: this.#dataset.organization,
			version: this.tag,
		});
	}

	/**
	 * @param {[options: {label?: string, releaseNotes?: string}]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['label', 'releaseNotes'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * Deletes the version. It can be restored with undelete().
	 *
	 * @param {[options?: {waitForFinalization?: boolean, signal?: AbortSignal}]} args With `waitForFinalization`, wait
	 *   until the deletion has been finalized, after which the dataset can be released, unreleased, or deleted again. The
	 *   signal stops waiting, but doesn't cancel the deletion.
	 * @returns {Promise<this>}
	 */
	async delete(...args) {
		const { waitForFinalization, signal } = parseArgs(args, [], {
			defaults: { waitForFinalization: false },
			allowed: ['signal'],
		});
		this._updateProperties(await makeRequest({ method: 'DELETE', path: this.uri }));
		if (waitForFinalization) {
			await waitForVersionFinalization(this, { signal });
		}
		return this;
	}

	/**
	 * Restores a deleted version.
	 * @returns {Promise<this>}
	 */
	async undelete() {
		this._updateProperties(await makeRequest({ method: 'POST', path: `${this.uri}/undelete` }));
		return this;
	}

	/**
	 * @returns {Promise<Version|null>} The version before this one, or null if this is the first version
	 */
	async previousVersion() {
		return this.#adjacentVersion('previousVersion');
	}

	/**
	 * @returns {Promise<Version|null>} The version after this one, or null if this is the latest version
	 */
	async nextVersion() {
		return this.#adjacentVersion('nextVersion');
	}

	async #adjacentVersion(property) {
		if (!this.properties || !(property in this.properties)) {
			await this.get();
		}
		const version = this.properties[property];
		return version ? new Version(version.tag, { dataset: this.#dataset, properties: version }) : null;
	}
}
