import Base from './Base.js';
import { makeRequest, sleep } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

/**
 * @typedef {object} VariableOptions One of table, query, or upload is required
 * @property {import('./Table.js').default} [table]
 * @property {import('./Query.js').default} [query]
 * @property {import('./Upload.js').default} [upload]
 * @property {Record<string, any>} [properties]
 */

export default class Variable extends Base {
	/**
	 * A variable of a table, query, or upload.
	 *
	 * @param {[name: string, options: VariableOptions] | [options: VariableOptions & {name: string}]} args
	 */
	constructor(...args) {
		super();
		const { name, table, query, upload, properties } = parseArgs(args, ['name'], {
			allowed: ['table', 'query', 'upload', 'properties'],
		});
		/** @type {string} */
		this.name = name;
		/** @type {import('./Table.js').default | undefined} */
		this.table = table;
		/** @type {import('./Query.js').default | undefined} */
		this.query = query;
		/** @type {import('./Upload.js').default | undefined} */
		this.upload = upload;
		this.properties = properties;
		this.uri = properties?.uri ?? `${(table || query || upload).uri}/variables/${encodeURIComponent(name)}`;
	}

	get type() {
		return this.properties?.type;
	}

	/**
	 * @param {[options: {label?: string, description?: string, valueLabels?: Record<string, string>}]} args
	 *   `valueLabels` maps values to their labels
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
	 *
	 * @param {[options?: {signal?: AbortSignal}]} args
	 * @returns {Promise<Record<string, any>>}
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
