import Base from './Base.js';
import { resolveWorkflowChild } from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { definedValues } from '../common/references.js';

export default class Parameter extends Base {
	/**
	 * @param {string} name The parameter's name. If no workflow is given, this may be fully qualified
	 *   (`owner.workflow.parameter`), or else the parameter is in the configured defaultWorkflow.
	 * @param {object} [options]
	 * @param {import('./Workflow.js').default|string} [options.workflow]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const options = parseArgs(args, ['name'], { allowed: ['workflow', 'properties'] });
		const { name, workflow } = resolveWorkflowChild('parameter', options.name, options.workflow);
		this.name = name;
		this.workflow = workflow;
		this.properties = options.properties;
		this.uri = options.properties?.uri ?? `${workflow.uri}/parameters/${encodeURIComponent(name)}`;
	}

	toString() {
		return `<Parameter ${this.workflow.qualifiedReference}.${this.name}>`;
	}

	/**
	 * @param {object} options
	 * @param {any[]} options.values
	 * @param {string} [options.type] The values' type (e.g. `string`, `integer`). Inferred if not given.
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
	 * @param {object} options
	 * @param {string} [options.name]
	 * @param {string} [options.type]
	 * @param {any[]} [options.values]
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		const options = parseArgs(args, [], { allowed: ['name', 'type', 'values'] });
		this._updateProperties(await makeRequest({ method: 'PATCH', path: this.uri, payload: definedValues(options) }));
		return this;
	}

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

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.name = properties.name ?? this.name;
	}
}
