import Base from './Base.js';
import { parseArgs } from '../common/args.js';

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

	toString() {
		return `<Variable ${this.name}${this.type ? ` (${this.type})` : ''}>`;
	}
}
