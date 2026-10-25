import Base from './Base.js';
import User from './User.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

export default class Member extends Base {
	/**
	 * A member of an organization.
	 *
	 * @param {string} name The member's username
	 * @param {object} options
	 * @param {import('./Organization.js').default} options.organization
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name, organization, properties } = parseArgs(args, ['name'], {
			allowed: ['organization', 'properties'],
		});
		this.name = name;
		this.organization = organization;
		this.user = new User(name, { properties: properties?.user });
		this.uri = properties?.uri ?? `${organization.uri}/members/${encodeURIComponent(name)}`;
		this.properties = properties;
	}

	toString() {
		return `<Member ${this.organization.name}.${this.name}>`;
	}

	/**
	 * @param {object} options
	 * @param {string} [options.status]
	 * @param {string[]} [options.labels] Replaces the member's labels
	 * @param {string[]} [options.labelsToAdd]
	 * @param {string[]} [options.labelsToRemove]
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['status', 'labels', 'labelsToAdd', 'labelsToRemove'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * @param {string} text
	 * @returns {Promise<this>}
	 */
	async addComment(...args) {
		const { text } = parseArgs(args, ['text']);
		await makeRequest({ method: 'POST', path: `${this.uri}/comments`, payload: { text } });
		return this;
	}

	_updateProperties(properties) {
		super._updateProperties(properties);
		if (properties.user) {
			this.user.properties = { ...this.user.properties, ...properties.user };
		}
	}
}
