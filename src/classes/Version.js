import Base from './Base.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';
import Dataset, { normalizeVersionTag } from './Dataset.js';

export default class Version extends Base {
	#dataset;

	/**
	 * @param {string} tag The version tag, e.g. `v1_0`, `current`, or `next`
	 * @param {object} options
	 * @param {Dataset} options.dataset
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { tag, dataset, properties } = parseArgs(args, ['tag'], { allowed: ['dataset', 'properties'] });
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
	 * @param {object} options
	 * @param {string} [options.label]
	 * @param {string} [options.releaseNotes]
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['label', 'releaseNotes'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * Deletes the version. It can be restored with undelete().
	 * @returns {Promise<this>}
	 */
	async delete() {
		this._updateProperties(await makeRequest({ method: 'DELETE', path: this.uri }));
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
