import Base from './Base.js';
import User from './User.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

/** @typedef {import('./Organization.js').default} Organization */

export default class Member extends Base {
	/**
	 * A member of an organization.
	 *
	 * @param {[name: string, options: {organization: Organization, properties?: Record<string, any>}] | [options: {name: string, organization: Organization, properties?: Record<string, any>}]} args
	 *   The member's username
	 */
	constructor(...args) {
		super();
		const { name, organization, properties } = parseArgs(args, ['name'], {
			allowed: ['organization', 'properties'],
		});
		/** @type {string} */
		this.name = name;
		/** @type {Organization} */
		this.organization = organization;
		/** @type {User} */
		this.user = new User(name, { properties: properties?.user });
		this.uri = properties?.uri ?? `${organization.uri}/members/${encodeURIComponent(name)}`;
		this.properties = properties;
	}

	toString() {
		return `<Member ${this.organization.name}.${this.name}>`;
	}

	/**
	 * @param {[options: {status?: string, labels?: string[], labelsToAdd?: string[], labelsToRemove?: string[]}]} args
	 *   `labels` replaces the member's labels
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['status', 'labels', 'labelsToAdd', 'labelsToRemove'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * @param {[text: string] | [options: {text: string}]} args
	 * @returns {Promise<this>}
	 */
	async addComment(...args) {
		const { text } = parseArgs(args, ['text']);
		await makeRequest({ method: 'POST', path: `${this.uri}/comments`, payload: { text } });
		return this;
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		if (properties.user) {
			this.user.properties = { ...this.user.properties, ...properties.user };
		}
	}
}
