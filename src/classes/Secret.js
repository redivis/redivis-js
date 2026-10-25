import Base from './Base.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';

/** @typedef {import('./User.js').default} User */
/** @typedef {import('./Organization.js').default} Organization */

export default class Secret extends Base {
	/**
	 * A secret, belonging to a user or organization.
	 *
	 * @param {[name: string, options: {user?: User, organization?: Organization}] | [options: {name: string, user?: User, organization?: Organization}]} args
	 */
	constructor(...args) {
		super();
		const { name, user, organization } = parseArgs(args, ['name'], { allowed: ['user', 'organization'] });
		/** @type {string} */
		this.name = name;
		/** @type {User | undefined} */
		this.user = user;
		/** @type {Organization | undefined} */
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
