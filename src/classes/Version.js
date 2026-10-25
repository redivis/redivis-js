import Base from './Base.js';
import { parseArgs } from '../common/args.js';
import { normalizeVersionTag } from './Dataset.js';

export default class Version extends Base {
	/**
	 * @param {string} tag The version tag, e.g. `v1_0`, `current`, or `next`
	 * @param {object} options
	 * @param {import('./Dataset.js').default} options.dataset
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { tag, dataset, properties } = parseArgs(args, ['tag'], { allowed: ['dataset', 'properties'] });
		this.tag = normalizeVersionTag(tag);
		this.dataset = dataset;
		this.uri = properties?.uri ?? `${dataset.uri}/versions/${encodeURIComponent(this.tag)}`;
		this.properties = properties;
	}

	toString() {
		return `<Version ${this.dataset.qualifiedReference}:${this.tag}>`;
	}
}
