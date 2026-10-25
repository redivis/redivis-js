import Base from './Base.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';

export default class Secret extends Base {
	/**
	 * @param {string} name
	 * @param {object} options One of user or organization is required
	 * @param {import('./User.js').default} [options.user]
	 * @param {import('./Organization.js').default} [options.organization]
	 */
	constructor(...args) {
		super();
		const { name, user, organization } = parseArgs(args, ['name'], { allowed: ['user', 'organization'] });
		this.name = name;
		this.user = user;
		this.organization = organization;
		this.uri = `${(user || organization).uri}/secrets/${encodeURIComponent(name)}`;
	}

	toString() {
		return `<Secret ${(this.user || this.organization).name}.${this.name}>`;
	}

	/**
	 * @returns {Promise<string>} The secret's value
	 */
	async getValue() {
		const { value } = await makeRequest({ method: 'GET', path: this.uri });
		return value;
	}
}
