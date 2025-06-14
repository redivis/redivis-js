import { makeRequest, makeRowsRequest } from '../common/apiRequest.js';
import Variable from './Variable.js';

export default class Query {
	constructor(argsQuery, options = {}) {
		let onFetchCallback
		this.fetchingPromise = new Promise((resolve) => onFetchCallback = resolve);
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
				onFetchCallback()
				this.properties = res;
				this.uri = `/queries/${this.properties.id}`;
			})
			.catch((e) => {
				this.error = e;
				onFetchCallback()
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
		return this.properties.outputSchema.map((variable) => new Variable({ ...variable, query: this }));
	}

	async listRows(maxResults) {
		await this.#waitForFinish();
		maxResults =
			maxResults === undefined
				? this.properties.outputNumRows
				: Math.min(maxResults, this.properties.outputNumRows);
		const mappedVariables = await this.listVariables();
		const res = await makeRowsRequest({ uri: this.uri, maxResults, mappedVariables });
		return res;
	}

	async #waitForFinish() {
		while (true) {
			await this.fetchingPromise
			if (this.error) {
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
