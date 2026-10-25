import Base from './Base.js';
import Table, { tableReferenceForWrite } from './Table.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { waitForRun } from '../common/jobs.js';
import { definedValues } from '../common/references.js';

/** @typedef {import('./Workflow.js').default} Workflow */

export default class Transform extends Base {
	/**
	 * A transform in a workflow.
	 *
	 * @param {[name?: string, options?: {workflow?: Workflow | string, properties?: Record<string, any>}] | [options: {name?: string, workflow?: Workflow | string, properties?: Record<string, any>}]} args
	 *   The transform's name. If no workflow is given, this may be fully qualified (`owner.workflow.transform`), or else the
	 *   transform is in the configured `defaultWorkflow`. Optional when creating a
	 *   transform, in which case a name is generated.
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('transform', options.name, options.workflow);
		const { properties } = options;
		/** @type {string | undefined} */
		this.name = name;
		/** @type {Workflow} */
		this.workflow = workflow;
		/** @type {Record<string, any> | undefined} */
		this.properties = properties;
		const references = getWorkflowChildReferences({ name, workflow, properties, collection: 'transforms' });
		/** @type {string | undefined} */
		this.qualifiedReference = references.qualifiedReference;
		/** @type {string | undefined} */
		this.scopedReference = references.scopedReference;
		/** @type {string} */
		this.uri = references.uri;
	}

	/**
	 * @param {[options: {sourceTable: Table | string, query?: string}]} args The table (or its qualified reference) that
	 *   the transform is built on, and its SQL query
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const { sourceTable, query } = parseArgs(args, [], { allowed: ['sourceTable', 'query'] });
		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${this.workflow.uri}/transforms`,
				payload: definedValues({
					name: this.name,
					sourceTable: await tableReferenceForWrite(sourceTable),
					query,
				}),
			}),
		);
		return this;
	}

	/**
	 * @param {[options: {name?: string, sourceTable?: Table | string, query?: string}]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const { name, sourceTable, query } = parseArgs(args, [], { allowed: ['name', 'sourceTable', 'query'] });
		this._updateProperties(
			await makeRequest({
				method: 'PATCH',
				path: this.uri,
				payload: definedValues({ name, sourceTable: await tableReferenceForWrite(sourceTable), query }),
			}),
		);
		return this;
	}

	/**
	 * Runs the transform, and (by default) waits for the run to finish, throwing a JobError if it fails.
	 *
	 * @param {[options?: {waitForFinish?: boolean, signal?: AbortSignal}]} args The signal stops waiting, but doesn't
	 *   cancel the run
	 * @returns {Promise<this>}
	 */
	async run(...args) {
		const { waitForFinish, signal } = parseArgs(args, [], {
			defaults: { waitForFinish: true },
			allowed: ['signal'],
		});
		const properties = await makeRequest({ method: 'POST', path: `${this.uri}/run` });
		this._updateProperties(properties);
		if (waitForFinish) {
			await waitForRun(this, properties, { signal });
		}
		return this;
	}

	/**
	 * Cancels the transform's current run.
	 * @returns {Promise<this>}
	 */
	async cancel() {
		this._updateProperties(await makeRequest({ method: 'POST', path: `${this.uri}/cancel` }));
		return this;
	}

	/**
	 * @returns {Promise<Table[]>} Every table that the transform references
	 */
	async referencedTables() {
		await this.get();
		return this.properties.referencedTables.map(tableFromProperties);
	}

	/**
	 * @returns {Promise<Table>}
	 */
	async sourceTable() {
		await this.get();
		return tableFromProperties(this.properties.sourceTable);
	}

	/**
	 * @returns {Promise<Table>}
	 */
	async outputTable() {
		await this.get();
		return tableFromProperties(this.properties.outputTable);
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}

export function tableFromProperties(properties) {
	return new Table(properties.qualifiedReference, { properties });
}

// The references of a transform or notebook, which are addressed by their qualified reference
export function getWorkflowChildReferences({ name, workflow, properties, collection }) {
	const qualifiedReference =
		properties?.qualifiedReference ?? (name === undefined ? undefined : `${workflow.qualifiedReference}.${name}`);
	return {
		qualifiedReference,
		scopedReference: properties?.scopedReference ?? name,
		uri: properties?.uri ?? (qualifiedReference && `/${collection}/${encodeURIComponent(qualifiedReference)}`),
	};
}
