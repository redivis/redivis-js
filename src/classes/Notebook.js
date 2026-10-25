import Base from './Base.js';
import { tableReferenceForWrite } from './Table.js';
import { setWorkflowChildReferences, tableFromProperties } from './Transform.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { waitForRun } from '../common/jobs.js';
import { definedValues } from '../common/references.js';

export default class Notebook extends Base {
	/**
	 * @param {string} name The notebook's name. If no workflow is given, this may be fully qualified
	 *   (`owner.workflow.notebook`), or else the notebook is in the configured defaultWorkflow.
	 * @param {object} [options]
	 * @param {import('./Workflow.js').default|string} [options.workflow]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('notebook', options.name, options.workflow);
		setWorkflowChildReferences(this, { name, workflow, properties: options.properties, collection: 'notebooks' });
	}

	/**
	 * @param {object} options
	 * @param {string} [options.name]
	 * @param {import('./Table.js').default|string} [options.sourceTable]
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
	 * Runs the notebook.
	 * @param {object} [options]
	 * @param {boolean} [options.waitForFinish=true] Wait for the run to finish, throwing a JobError if it fails
	 * @param {AbortSignal} [options.signal] Stops waiting (but doesn't stop the run)
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

	async referencedTables() {
		await this.get();
		return this.properties.referencedTables.map(tableFromProperties);
	}

	async sourceTable() {
		await this.get();
		return tableFromProperties(this.properties.sourceTable);
	}

	async outputTable() {
		await this.get();
		return tableFromProperties(this.properties.outputTable);
	}

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}
