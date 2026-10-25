import Base from './Base.js';
import { tableReferenceForWrite } from './Table.js';
import { getWorkflowChildReferences, tableFromProperties } from './Transform.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { waitForRun } from '../common/jobs.js';
import { definedValues } from '../common/references.js';

/** @typedef {import('./Workflow.js').default} Workflow */
/** @typedef {import('./Table.js').default} Table */

export default class Notebook extends Base {
	/**
	 * A notebook in a workflow.
	 *
	 * @param {[name: string, options?: {workflow?: Workflow | string, properties?: Record<string, any>}] | [options: {name: string, workflow?: Workflow | string, properties?: Record<string, any>}]} args
	 *   The notebook's name. If no workflow is given, this may be fully qualified (`owner.workflow.notebook`), or else the
	 *   notebook is in the configured `defaultWorkflow`.
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('notebook', options.name, options.workflow);
		const { properties } = options;
		/** @type {string | undefined} */
		this.name = name;
		/** @type {Workflow} */
		this.workflow = workflow;
		/** @type {Record<string, any> | undefined} */
		this.properties = properties;
		const references = getWorkflowChildReferences({ name, workflow, properties, collection: 'notebooks' });
		/** @type {string | undefined} */
		this.qualifiedReference = references.qualifiedReference;
		/** @type {string | undefined} */
		this.scopedReference = references.scopedReference;
		/** @type {string} */
		this.uri = references.uri;
	}

	/**
	 * @param {[options: {name?: string, sourceTable?: Table | string}]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const { name, sourceTable } = parseArgs(args, [], { allowed: ['name', 'sourceTable'] });
		this._updateProperties(
			await makeRequest({
				method: 'PATCH',
				path: this.uri,
				payload: definedValues({ name, sourceTable: await tableReferenceForWrite(sourceTable) }),
			}),
		);
		return this;
	}

	/**
	 * Runs the notebook, and (by default) waits for the run to finish, throwing a JobError if it fails.
	 *
	 * @param {[options?: {waitForFinish?: boolean, signal?: AbortSignal}]} args The signal stops waiting, but doesn't
	 *   stop the run
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
	 * Stops the notebook's current run.
	 * @returns {Promise<this>}
	 */
	async stop() {
		this._updateProperties(await makeRequest({ method: 'POST', path: `${this.uri}/stop` }));
		return this;
	}

	/**
	 * @returns {Promise<Table[]>} Every table that the notebook references
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
