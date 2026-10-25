import Query from './Query.js';
import Table from './Table.js';
import { makePaginatedRequest } from '../common/apiRequest.js';

export default class Workflow {
	constructor(argName, options = {}) {
		if (typeof argName === 'object') {
			options = argName;
			argName = undefined;
		}
		const { name = argName, user, properties } = options;
		this.user = user;
		this.name = name;
		this.identifier = `${user.name}.${name}`;
		this.uri = `/workflows/${encodeURIComponent(this.identifier)}`;
		this.properties = properties;
	}

	getProperty(property) {
		return this.properties?.[property];
	}

	query(query, options = {}) {
		return new Query({ query, ...options, defaultWorkflow: this });
	}

	table(name, options = {}) {
		return new Table({ name, ...options, workflow: this });
	}

	async listTables({ maxResults, includeDatasetTables } = {}) {
		const tables = await makePaginatedRequest({
			method: 'GET',
			pageSize: 100,
			path: `${this.uri}/tables`,
			maxResults,
			query: { includeDatasetTables },
		});

		return tables.map((table) => new Table(table.name, { workflow: this, properties: table }));
	}
}
