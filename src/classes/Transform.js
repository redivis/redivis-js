import Base from './Base.js';
import Table, { tableReferenceForWrite } from './Table.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { waitForRun } from '../common/jobs.js';
import { definedValues } from '../common/references.js';

export default class Transform extends Base {
	/**
	 * @param {string} [name] The transform's name. If no workflow is given, this may be fully qualified
	 *   (`owner.workflow.transform`), or else the transform is in the configured defaultWorkflow. Optional when
	 *   creating a transform, in which case a name is generated.
	 * @param {object} [options]
	 * @param {import('./Workflow.js').default|string} [options.workflow]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('transform', options.name, options.workflow);
		setWorkflowChildReferences(this, { name, workflow, properties: options.properties, collection: 'transforms' });
	}

	/**
	 * @param {object} options
	 * @param {Table|string} options.sourceTable The table (or its qualified reference) that the transform is built on
	 * @param {string} [options.query] The transform's SQL query
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
	 * @param {object} options
	 * @param {string} [options.name]
	 * @param {Table|string} [options.sourceTable]
	 * @param {string} [options.query]
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
	 * Runs the transform, creating (or updating) its output table.
	 * @param {object} [options]
	 * @param {boolean} [options.waitForFinish=true] Wait for the run to finish, throwing a JobError if it fails
	 * @param {AbortSignal} [options.signal] Stops waiting (but doesn't cancel the run)
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

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}

export function tableFromProperties(properties) {
	return new Table(properties.qualifiedReference, { properties });
}

// Sets the name and references of a transform or notebook, which are addressed by their qualified reference
export function setWorkflowChildReferences(instance, { name, workflow, properties, collection }) {
	instance.name = name;
	instance.workflow = workflow;
	instance.properties = properties;
	instance.scopedReference = properties?.scopedReference ?? name;
	instance.qualifiedReference =
		properties?.qualifiedReference ?? (name === undefined ? undefined : `${workflow.qualifiedReference}.${name}`);
	instance.uri =
		properties?.uri ??
		(instance.qualifiedReference && `/${collection}/${encodeURIComponent(instance.qualifiedReference)}`);
}
