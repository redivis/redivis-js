import Upload from './Upload.js';
import Variable from './Variable.js';
import { makeRequest, makePaginatedRequest, makeRowsRequest } from '../common/apiRequest.js';

// TODO: handle periods in name (properly escape) — and for all other entities
export default class Table {
	constructor(argName, options = {}) {
		if (typeof argName === 'object') {
			options = argName;
			argName = undefined;
		}
		const { name = argName, sample = false, dataset, project, properties } = options;
		const parent = dataset || project;
		const owner = parent.organization || parent.user;
		const sampleString = sample ? ':sample' : '';
		const versionString = dataset ? `:${dataset.version}` : '';
		this.hasPopulatedProperties = false;
		this.name = name;
		this.dataset = dataset;
		this.project = project;
		this.identifier = `${owner.name}.${parent.name}${versionString}.${this.name}${sampleString}`;
		this.uri = `/tables/${encodeURIComponent(this.identifier)}`;
		this.properties = { name, identifier: this.identifier, uri: this.uri, dataset, project, ...properties };
	}

	// TODO: validate properties usage
	getProperty(prop) {
		return this.properties?.[prop];
	}

	toString() {
		return JSON.stringify(this.properties, null, 2);
	}

	variable(name) {
		return new Variable(name, { table: this });
	}

	async exists() {
		try {
			await makeRequest({ method: 'GET', path: this.uri });
		} catch (e) {
			if (e.status !== 404) {
				throw e;
			}
			return false;
		}
		return true;
	}

	async get() {
		this.properties = await makeRequest({ method: 'GET', path: this.uri });
		this.uri = this.properties.uri;
		this.hasPopulatedProperties = true;
		return this;
	}

	async listVariables({ maxResults } = {}) {
		let variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		variables = variables.map((variable) => new Variable({ ...variable, table: this }));
		if (maxResults === undefined || variables.length < maxResults) {
			this.variables = variables;
		}
		return variables;
	}

	async listRows(argMaxResults, options = {}) {
		if (typeof argMaxResults === 'object') {
			options = argMaxResults;
			argMaxResults = undefined;
		}
		let { maxResults = argMaxResults, variables } = options;

		if (!this.variables) {
			this.variables = await this.listVariables({ maxResults: 10000 });
		}
		if (!this.hasPopulatedProperties) {
			await this.get();
		}
		maxResults = maxResults === undefined ? this.properties.numRows : Math.min(maxResults, this.properties.numRows);

		let selectedVariables;

		if (variables?.length) {
			selectedVariables = variables.map((name) => {
				const variable = this.variables.find(
					({ name: variableName }) => variableName.toLowerCase() === name.toLowerCase(),
				);
				if (!variable) {
					throw new Error(`The variable ${name} was not found in this table`);
				}
				return { name, type: variable.type };
			});
		}

		const res = await makeRowsRequest({
			uri: this.uri,
			maxResults,
			selectedVariables: selectedVariables ? selectedVariables.map((variable) => variable.name) : undefined,
			format: 'avro',
		});

		return res;
	}
}
