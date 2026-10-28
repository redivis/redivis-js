import Base from './Base.js';
import Dataset from './Dataset.js';
import Member from './Member.js';
import Secret from './Secret.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { NotFoundError } from '../common/errors.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

export default class Organization extends Base {
	/**
	 * An organization.
	 *
	 * @param {[name: string, options?: {properties?: Record<string, any>}] | [options: {name: string, properties?: Record<string, any>}]} args
	 *   The organization's username
	 */
	constructor(...args) {
		super();
		const { name, properties } = parseArgs(args, ['name'], { allowed: ['properties'] });
		/** @type {string} */
		this.name = name;
		this.uri = `/organizations/${encodeURIComponent(name)}`;
		this.properties = { kind: 'organization', userName: name, uri: this.uri, ...properties };
	}

	/**
	 * @param {[name: string, options?: {version?: string}] | [options: {name: string, version?: string}]} args
	 * @returns {Dataset}
	 */
	dataset(...args) {
		const { name, version } = parseArgs(args, ['name'], { allowed: ['version'] });
		return new Dataset(name, { version, organization: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Workflow}
	 */
	workflow(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Workflow(name, { organization: this });
	}

	/**
	 * @param {NameArgs} args The member's username
	 * @returns {Member}
	 */
	member(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Member(name, { organization: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Secret}
	 */
	secret(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Secret(name, { organization: this });
	}

	// There's no endpoint to get an organization directly, so check whether its datasets can be listed
	/**
	 * Whether the organization exists.
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
	 * @param {[maxResults?: number | null, options?: {labels?: string[]}] | [options?: {maxResults?: number | null, labels?: string[]}]} args
	 *   `labels` only lists datasets with all of these labels
	 * @returns {Promise<Dataset[]>}
	 */
	async listDatasets(...args) {
		const { maxResults, labels } = parseArgs(args, ['maxResults'], { allowed: ['labels'] });
		const datasets = await makePaginatedRequest({
			path: `${this.uri}/datasets`,
			pageSize: 100,
			maxResults,
			query: { labels: labels?.join(',') },
		});
		return datasets.map((dataset) => new Dataset(dataset.name, { organization: this, properties: dataset }));
	}

	/**
	 * @param {[maxResults?: number | null, options?: {labels?: string[], statuses?: string[]}] | [options?: {maxResults?: number | null, labels?: string[], statuses?: string[]}]} args
	 *   `labels` only lists members with all of these labels; `statuses` only those with one of these statuses
	 * @returns {Promise<Member[]>}
	 */
	async listMembers(...args) {
		const { maxResults, labels, statuses } = parseArgs(args, ['maxResults'], { allowed: ['labels', 'statuses'] });
		const members = await makePaginatedRequest({
			path: `${this.uri}/members`,
			pageSize: 500,
			maxResults,
			query: { labels: labels?.join(','), statuses: statuses?.join(',') },
		});
		return members.map((member) => new Member(member.user.name, { organization: this, properties: member }));
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Workflow[]>}
	 */
	async listWorkflows(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const workflows = await makePaginatedRequest({ path: `${this.uri}/workflows`, pageSize: 100, maxResults });
		return workflows.map((workflow) => new Workflow(workflow.name, { organization: this, properties: workflow }));
	}
}
