import Base from './Base.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

/** @typedef {import('./Workflow.js').default} Workflow */

export default class Parameter extends Base {
	/**
	 * A parameter of a workflow.
	 *
	 * @param {[name: string, options?: {workflow?: Workflow | string, properties?: Record<string, any>}] | [options: {name: string, workflow?: Workflow | string, properties?: Record<string, any>}]} args
	 *   The parameter's name. If no workflow is given, this may be fully qualified (`owner.workflow.parameter`), or else the
	 *   parameter is in the configured `defaultWorkflow`.
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('parameter', options.name, options.workflow);
		/** @type {string} */
		this.name = name;
		/** @type {Workflow} */
		this.workflow = workflow;
		this.properties = options.properties;
		this.uri = options.properties?.uri ?? `${workflow.uri}/parameters/${encodeURIComponent(name)}`;
	}

	toString() {
		return `<Parameter ${this.workflow.qualifiedReference}.${this.name}>`;
	}

	/**
	 * @param {[options: {values: any[], type?: string}]} args The type of the values (e.g. `string`, `integer`) is
	 *   inferred if not given
	 * @returns {Promise<this>}
	 */
	async create(...args) {
		const { values, type } = parseArgs(args, [], { allowed: ['values', 'type'] });
		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${this.workflow.uri}/parameters`,
				payload: definedValues({ name: this.name, values, type }),
			}),
		);
		return this;
	}

	/**
	 * @param {[options: {name?: string, type?: string, values?: any[]}]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['name', 'type', 'values'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

	/**
	 * @returns {Promise<void>}
	 */
	async delete() {
		await makeRequest({ method: 'DELETE', path: this.uri });
	}

	/**
	 * @returns {Promise<any[]>} The parameter's values
	 */
	async getValues() {
		await this.get();
		return this.properties.values;
	}

	/** @protected */
	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}
