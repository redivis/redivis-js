import Base from './Base.js';
import Dataset from './Dataset.js';
import Member from './Member.js';
import Secret from './Secret.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { NotFoundError } from '../common/errors.js';

export default class Organization extends Base {
	/**
	 * @param {string} name The organization's username
	 * @param {object} [options]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name, properties } = parseArgs(args, ['name'], { allowed: ['properties'] });
		this.name = name;
		this.uri = `/organizations/${encodeURIComponent(name)}`;
		this.properties = { kind: 'organization', userName: name, uri: this.uri, ...properties };
	}

	dataset(...args) {
		const { name, version } = parseArgs(args, ['name'], { allowed: ['version'] });
		return new Dataset(name, { version, organization: this });
	}

	workflow(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Workflow(name, { organization: this });
	}

	member(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Member(name, { organization: this });
	}

	secret(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Secret(name, { organization: this });
	}

	// There's no endpoint to get an organization directly, so check whether its datasets can be listed
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
	 * @param {number} [maxResults]
	 * @param {object} [options]
	 * @param {string[]} [options.labels] Only list datasets with all of these labels
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
	 * @param {number} [maxResults]
	 * @param {object} [options]
	 * @param {string[]} [options.labels] Only list members with all of these labels
	 * @param {string[]} [options.statuses] Only list members with one of these statuses
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

	async listWorkflows(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const workflows = await makePaginatedRequest({ path: `${this.uri}/workflows`, pageSize: 100, maxResults });
		return workflows.map((workflow) => new Workflow(workflow.name, { organization: this, properties: workflow }));
	}
}
