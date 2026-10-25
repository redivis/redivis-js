import Base from './Base.js';
import { makeRequest, sleep } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

export default class Variable extends Base {
	/**
	 * @param {string} name
	 * @param {object} options One of table, query, or upload is required
	 * @param {import('./Table.js').default} [options.table]
	 * @param {import('./Query.js').default} [options.query]
	 * @param {object} [options.upload]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name, table, query, upload, properties } = parseArgs(args, ['name'], {
			allowed: ['table', 'query', 'upload', 'properties'],
		});
		this.name = name;
		this.table = table;
		this.query = query;
		this.upload = upload;
		this.properties = properties;
		this.uri = properties?.uri ?? `${(table || query || upload).uri}/variables/${encodeURIComponent(name)}`;
	}

	get type() {
		return this.properties?.type;
	}

	/**
	 * @param {object} options
	 * @param {string} [options.label]
	 * @param {string} [options.description]
	 * @param {object} [options.valueLabels] A map of values to their labels
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['label', 'description', 'valueLabels'] });
		if (this.table) {
			const uri = this.table.uri;
			await this.table._resolveForWrite();
			if (this.table.uri !== uri) {
				this.uri = `${this.table.uri}/variables/${encodeURIComponent(this.name)}`;
			}
		}
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * Returns the variable's summary statistics, waiting for them to be computed if needed.
	 * @param {object} [options]
	 * @param {AbortSignal} [options.signal]
	 * @returns {Promise<object>}
	 */
	async getStatistics(...args) {
		const { signal } = parseArgs(args, [], { allowed: ['signal'] });
		while (true) {
			const statistics = await makeRequest({ method: 'GET', path: `${this.uri}/statistics`, signal });
			if (statistics.status !== 'running' && statistics.status !== 'queued') {
				return statistics;
			}
			await sleep(2000, signal);
		}
	}

	toString() {
		return `<Variable ${this.name}${this.type ? ` (${this.type})` : ''}>`;
	}
}
