import Base from './Base.js';
import Dataset from './Dataset.js';
import Secret from './Secret.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { NotFoundError } from '../common/errors.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

export default class User extends Base {
	/**
	 * A user.
	 *
	 * @param {[name: string, options?: {properties?: Record<string, any>}] | [options: {name: string, properties?: Record<string, any>}]} args
	 *   The user's username
	 */
	constructor(...args) {
		super();
		const { name, properties } = parseArgs(args, ['name'], { allowed: ['properties'] });
		/** @type {string} */
		this.name = name;
		this.uri = `/users/${encodeURIComponent(name)}`;
		this.properties = { kind: 'user', userName: name, uri: this.uri, ...properties };
	}

	/**
	 * @param {[name: string, options?: {version?: string}] | [options: {name: string, version?: string}]} args
	 * @returns {Dataset}
	 */
	dataset(...args) {
		const { name, version } = parseArgs(args, ['name'], { allowed: ['version'] });
		return new Dataset(name, { version, user: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Workflow}
	 */
	workflow(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Workflow(name, { user: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Secret}
	 */
	secret(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Secret(name, { user: this });
	}

	// There's no endpoint to get a user directly, so check whether their datasets can be listed
	/**
	 * Whether the user exists.
	 * @returns {Promise<boolean>}
	 */
	async exists() {
		try {
			await makePaginatedRequest({ path: `${this.uri}/datasets`, maxResults: 1 });
			return true;
		} catch (e) {
			if (e instanceof NotFoundError) {
				return false;
			}
			throw e;
		}
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Dataset[]>}
	 */
	async listDatasets(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const datasets = await makePaginatedRequest({ path: `${this.uri}/datasets`, pageSize: 100, maxResults });
		return datasets.map((dataset) => new Dataset(dataset.name, { user: this, properties: dataset }));
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Workflow[]>}
	 */
	async listWorkflows(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const workflows = await makePaginatedRequest({ path: `${this.uri}/workflows`, pageSize: 100, maxResults });
		return workflows.map((workflow) => new Workflow(workflow.name, { user: this, properties: workflow }));
	}
}
