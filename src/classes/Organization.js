import Base from './Base.js';
import Dataset from './Dataset.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';

export default class Organization extends Base {
	/**
	 * @param {string} name The organization's username
	 * @param {object} [options]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name, properties } = parseArgs(args, ['name'], { allowed: ['properties'] });
		this.name = name;
		this.uri = `/organizations/${encodeURIComponent(name)}`;
		this.properties = { kind: 'organization', userName: name, uri: this.uri, ...properties };
	}

	dataset(...args) {
		const { name, version } = parseArgs(args, ['name'], { allowed: ['version'] });
		return new Dataset(name, { version, organization: this });
	}

	workflow(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Workflow(name, { organization: this });
	}

	// There's no endpoint to get an organization directly, so check whether its datasets can be listed
	async exists() {
		try {
			await makePaginatedRequest({ path: `${this.uri}/datasets`, maxResults: 1 });
			return true;
		} catch (e) {
			if (e.status === 404) {
				return false;
			}
			throw e;
		}
	}

	async listDatasets(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const datasets = await makePaginatedRequest({ path: `${this.uri}/datasets`, pageSize: 100, maxResults });
		return datasets.map((dataset) => new Dataset(dataset.name, { organization: this, properties: dataset }));
	}
}
