import { makeRequest, makeRowsRequest } from '../common/apiRequest.js';
import Variable from './Variable.js';

export default class Query {
	constructor(argsQuery, options = {}) {
		this.isFetching = true;
		if (typeof argsQuery === 'object') {
			options = argsQuery;
			argsQuery = undefined;
		}
		const { query = argsQuery, defaultProject, defaultDataset } = options;
		const payload = {
			query,
		};
		if (defaultProject) {
			payload.defaultProject = defaultProject.identifier;
		} else if (defaultDataset) {
			payload.defaultDataset = defaultDataset.identifier;
		}

		// TODO: only make the request when this.get is called
		makeRequest({ method: 'POST', path: '/queries', payload })
			.then((res) => {
				this.isFetching = false;
				this.properties = res;
				this.uri = `/queries/${this.properties.id}`;
			})
			.catch((e) => {
				this.error = e;
				this.isFetching = false;
			});
	}

	getProperty(prop) {
		return this.properties?.[prop];
	}

	toString() {
		return JSON.stringify(this.properties, null, 2);
	}

	async get() {
		this.properties = await makeRequest({ method: 'GET', path: this.uri });
		return this;
	}

	async listVariables() {
		await this.#waitForFinish();
		return this.properties.outputSchema.map((variable) => new Variable(variable));
	}

	async listRows(limit) {
		await this.#waitForFinish();
		const maxResults =
			limit === undefined ? this.properties.outputNumRows : Math.max(limit, this.properties.outputNumRows);
		return await makeRowsRequest({ uri: this.uri, maxResults });
	}

	async #waitForFinish() {
		while (true) {
			if (this.isFetching) {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				continue;
			} else if (this.error) {
				throw new Error(this.error);
			} else if (this.properties.status === 'completed') {
				break;
			} else if (this.properties.status === 'failed') {
				throw new Error(`Query job failed with message: ${this.properties.errorMessage}`);
			} else if (this.properties.status === 'cancelled') {
				throw new Error(`Query job was cancelled`);
			} else {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				await this.get();
			}
		}
	}
}
