import Base from './Base.js';
import Datasource from './Datasource.js';
import Notebook from './Notebook.js';
import Organization from './Organization.js';
import Parameter from './Parameter.js';
import Query from './Query.js';
import Table from './Table.js';
import Transform from './Transform.js';
import User from './User.js';
import { makePaginatedRequest, makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { definedValues, splitReference } from '../common/references.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('./Dataset.js').default} Dataset */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

/**
 * @typedef {object} WorkflowOptions
 * @property {User | string} [user]
 * @property {Organization | string} [organization]
 * @property {Record<string, any>} [properties]
 */

export default class Workflow extends Base {
	/**
	 * A workflow.
	 *
	 * @param {[name: string, options?: WorkflowOptions] | [options: WorkflowOptions & {name: string}]} args The workflow's
	 *   name. If no owner is given, this may be fully qualified (`owner.name`), or else the owner is the configured
	 *   `defaultUser` or `defaultOrganization`.
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

		/** @type {User | undefined} */
		this.user = user;
		/** @type {Organization | undefined} */
		this.organization = organization;
		/** @type {string} */
		this.name = name;
		/** @type {string} */
		this.scopedReference = properties?.scopedReference ?? this.name;
		/** @type {string} */
		this.qualifiedReference =
			properties?.qualifiedReference ?? `${(this.organization || this.user).name}.${this.scopedReference}`;
		this.uri = properties?.uri ?? `/workflows/${encodeURIComponent(this.qualifiedReference)}`;
		this.properties = properties;
	}

	/**
	 * Creates the workflow.
	 *
	 * @param {[options?: {description?: string, isPublic?: boolean}]} args `isPublic` lets anyone view the workflow
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const { description, isPublic } = parseArgs(args, [], {
			defaults: { isPublic: false },
			allowed: ['description'],
		});
		await this._rectifyAmbiguousOwner();
		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${(this.organization || this.user).uri}/workflows`,
				payload: definedValues({ name: this.name, description, isPublic }),
			}),
		);
		return this;
	}

	/**
	 * Deletes the workflow.
	 * @returns {Promise<void>}
	 */
	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * Returns a query, in which unqualified table references resolve within this workflow.
	 *
	 * @param {[query: string] | [options: {query: string}]} args
	 * @returns {Query}
	 */
	query(...args) {
		const { query } = parseArgs(args, ['query']);
		return new Query(query, { defaultWorkflow: this.qualifiedReference });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Table}
	 */
	table(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Table(name, { workflow: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Notebook}
	 */
	notebook(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Notebook(name, { workflow: this });
	}

	/**
	 * @param {[name?: string] | [options?: {name?: string}]} args Optional when creating a transform, in which case a
	 *   name is generated
	 * @returns {Transform}
	 */
	transform(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Transform(name, { workflow: this });
	}

	/**
	 * @param {NameArgs} args
	 * @returns {Parameter}
	 */
	parameter(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Parameter(name, { workflow: this });
	}

	/**
	 * @param {[source: string | Dataset | Workflow] | [options: {source: string | Dataset | Workflow}]} args The dataset or
	 *   workflow that's the datasource's source, or its qualified reference
	 * @returns {Datasource}
	 */
	datasource(...args) {
		const { source } = parseArgs(args, ['source']);
		return new Datasource(source, { workflow: this });
	}

	/**
	 * Updates the metadata of many variables across the workflow's tables at once.
	 *
	 * @param {[variables: Record<string, any>[]] | [options: {variables: Record<string, any>[]}]} args
	 * @returns {Promise<void>}
	 */
	async updateVariables(...args) {
		const { variables } = parseArgs(args, ['variables']);
		await makeRequest({ method: 'PATCH', path: `${this.uri}/variables`, payload: { variables } });
	}

	/**
	 * @param {[maxResults?: number | null, options?: {includeDatasources?: boolean}] | [options?: {maxResults?: number | null, includeDatasources?: boolean}]} args
	 *   `includeDatasources` also lists the tables of the workflow's datasources
	 * @returns {Promise<Table[]>}
	 */
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

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Datasource[]>}
	 */
	async listDatasources(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const datasources = await makePaginatedRequest({ path: `${this.uri}/dataSources`, pageSize: 100, maxResults });
		return datasources.map(
			(datasource) => new Datasource(datasource.id, { workflow: this, properties: datasource }),
		);
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Notebook[]>}
	 */
	async listNotebooks(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const notebooks = await makePaginatedRequest({ path: `${this.uri}/notebooks`, pageSize: 100, maxResults });
		return notebooks.map((notebook) => new Notebook(notebook.name, { workflow: this, properties: notebook }));
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Transform[]>}
	 */
	async listTransforms(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const transforms = await makePaginatedRequest({ path: `${this.uri}/transforms`, pageSize: 100, maxResults });
		return transforms.map((transform) => new Transform(transform.name, { workflow: this, properties: transform }));
	}

	/**
	 * @param {ListArgs} args
	 * @returns {Promise<Parameter[]>}
	 */
	async listParameters(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const parameters = await makePaginatedRequest({ path: `${this.uri}/parameters`, pageSize: 100, maxResults });
		return parameters.map((parameter) => new Parameter(parameter.name, { workflow: this, properties: parameter }));
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name;
		if (this.user && this.organization && properties.owner?.kind) {
			if (properties.owner.kind === 'user') {
				this.organization = undefined;
			} else {
				this.user = undefined;
			}
		}
	}

	// When the owner came from a qualified reference, we don't know whether it's a user or an organization until the
	//   API tells us (or we ask)
	/** @protected */
	async _rectifyAmbiguousOwner() {
		if (this.user && this.organization) {
			if (await this.organization.exists()) {
				this.user = undefined;
			} else {
				this.organization = undefined;
			}
		}
	}
}

// Resolves the workflow of a resource that lives within one (a parameter, transform, or notebook), given either its
//   fully qualified reference (`owner.workflow.name`) or its name and workflow. Falls back to the configured
//   defaultWorkflow.
export function resolveWorkflowChild(kind, name, workflow) {
	if (typeof workflow === 'string') {
		workflow = new Workflow(workflow);
	}
	if (!workflow) {
		const parts = name === undefined ? [] : splitReference(name);
		if (parts.length === 3) {
			workflow = new Workflow(`${parts[0]}.${parts[1]}`);
			name = parts[2];
		} else if (getConfigValue('defaultWorkflow')) {
			workflow = new Workflow(getConfigValue('defaultWorkflow'));
		} else {
			throw new ValueError(
				`Invalid ${kind} reference "${name}". It must be fully qualified (owner.workflow.${kind}) if no workflow is specified.`,
			);
		}
	}
	return { name, workflow };
}
