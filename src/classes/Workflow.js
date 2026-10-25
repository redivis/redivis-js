import Base from './Base.js';
import Organization from './Organization.js';
import Query from './Query.js';
import Table from './Table.js';
import User from './User.js';
import { makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { splitReference } from '../common/references.js';

export default class Workflow extends Base {
	/**
	 * @param {string} name The workflow's name. If no owner is given, this may be fully qualified (`owner.name`), or
	 *   else the owner is the configured defaultUser or defaultOrganization.
	 * @param {object} [options]
	 * @param {User|string} [options.user]
	 * @param {Organization|string} [options.organization]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		let { name, user, organization, properties } = parseArgs(args, ['name'], {
			allowed: ['user', 'organization', 'properties'],
		});
		if (typeof user === 'string') user = new User(user);
		if (typeof organization === 'string') organization = new Organization(organization);

		if (!user && !organization) {
			const parts = splitReference(name);
			if (parts.length === 2) {
				[user, organization] = [new User(parts[0]), new Organization(parts[0])];
				name = parts[1];
			} else if (getConfigValue('defaultUser')) {
				user = new User(getConfigValue('defaultUser'));
			} else if (getConfigValue('defaultOrganization')) {
				organization = new Organization(getConfigValue('defaultOrganization'));
			} else {
				throw new ValueError(
					`Invalid workflow reference "${name}". It must be fully qualified (owner.workflow) if no owner is specified.`,
				);
			}
		}

		this.user = user;
		this.organization = organization;
		this.name = name;
		this.scopedReference = properties?.scopedReference ?? this.name;
		this.qualifiedReference =
			properties?.qualifiedReference ?? `${(this.organization || this.user).name}.${this.scopedReference}`;
		this.uri = properties?.uri ?? `/workflows/${encodeURIComponent(this.qualifiedReference)}`;
		this.properties = properties;
	}

	query(...args) {
		const { query } = parseArgs(args, ['query']);
		return new Query(query, { defaultWorkflow: this.qualifiedReference });
	}

	table(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Table(name, { workflow: this });
	}

	async listTables(...args) {
		const { maxResults, includeDatasources } = parseArgs(args, ['maxResults'], {
			defaults: { includeDatasources: false },
		});
		const tables = await makePaginatedRequest({
			path: `${this.uri}/tables`,
			pageSize: 100,
			maxResults,
			query: includeDatasources ? { includeDataSources: true } : {},
		});

		return tables.map((table) => new Table(table.name, { workflow: this, properties: table }));
	}

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.qualifiedReference = properties.qualifiedReference;
		this.scopedReference = properties.scopedReference;
		this.name = properties.name;
		if (this.user && this.organization && properties.owner?.kind) {
			if (properties.owner.kind === 'user') {
				this.organization = undefined;
			} else {
				this.user = undefined;
			}
		}
	}
}
