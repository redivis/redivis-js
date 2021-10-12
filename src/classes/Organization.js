import Dataset from './Dataset.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
// TODO: listDatasets
// TODO: listMembers

export default class Organization {
	constructor(name) {
		this.name = name;
	}

	async listDatasets({ maxResults } = {}) {
		let datasets = await makePaginatedRequest({
			path: `/organizations/${encodeURIComponent(this.name)}/datasets`,
			pageSize: 100,
			maxResults,
		});
		datasets = datasets.map((dataset) => new Dataset({ ...dataset, organization: this }));

		return datasets;
	}

	dataset(name, options = {}) {
		return new Dataset({ name, ...options, organization: this });
	}
}
