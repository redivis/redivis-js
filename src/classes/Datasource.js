import Base from './Base.js';
import Dataset from './Dataset.js';
import Table from './Table.js';
import Version from './Version.js';
import Workflow from './Workflow.js';
import { makeRequest } from '../common/apiRequest.js';
import { isPlainObject, parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { definedValues } from '../common/references.js';

/**
 * @typedef {object} DatasourceUpdateOptions
 * @property {Dataset | string} [sourceDataset]
 * @property {Workflow | string} [sourceWorkflow]
 * @property {boolean} [sample] Whether to use the source dataset's sample
 * @property {Version | string} [version] The version of the source dataset to use
 * @property {Array<[Table | string, Table | string]> | Record<string, string>} [mappedTables] Pairs of
 *   [sourceTable, destinationTable] (or a map of their scoped references), for when tables were renamed in the new
 *   source
 */

export default class Datasource extends Base {
	/**
	 * A dataset or workflow that's a source of a workflow.
	 *
	 * @param {[source: string | Dataset | Workflow, options?: {workflow?: Workflow | string, properties?: Record<string, any>}] | [options: {source: string | Dataset | Workflow, workflow?: Workflow | string, properties?: Record<string, any>}]} args
	 *   The source dataset or workflow, or its qualified reference. The workflow defaults to the configured
	 *   `defaultWorkflow`.
	 */
	constructor(...args) {
		super();
		let { source, workflow, properties } = parseArgs(args, ['source'], { allowed: ['workflow', 'properties'] });
		if (typeof workflow === 'string') {
			workflow = new Workflow(workflow);
		} else if (!workflow) {
			if (!getConfigValue('defaultWorkflow')) {
				throw new ValueError('A workflow must be specified for the datasource, if there is no defaultWorkflow');
			}
			workflow = new Workflow(getConfigValue('defaultWorkflow'));
		}
		/** @type {Workflow} */
		this.workflow = workflow;
		/** @type {string} */
		this.sourceReference = toReference(source);
		this.uri = properties?.uri ?? `${workflow.uri}/dataSources/${encodeURIComponent(this.sourceReference)}`;
		this.properties = properties;
	}

	toString() {
		return `<Datasource ${this.sourceReference}>`;
	}

	/**
	 * Adds the source to the workflow.
	 * @returns {Promise<this>}
	 */
	async create() {
		const isDataset = await new Dataset(this.sourceReference.replace(/:sample\b/, '')).exists();
		this._updateProperties(
			await makeRequest({
				method: 'POST',
				path: `${this.workflow.uri}/dataSources`,
				payload: isDataset ? { sourceDataset: this.sourceReference } : { sourceWorkflow: this.sourceReference },
			}),
		);
		return this;
	}

	/**
	 * Changes the datasource's source, its version or sample, or how its tables are mapped to those of a new source.
	 *
	 * @param {[options: DatasourceUpdateOptions]} args
	 * @returns {Promise<this>}
	 */
	async update(...args) {
		let { sourceDataset, sourceWorkflow, sample, version, mappedTables } = parseArgs(args, [], {
			allowed: ['sourceDataset', 'sourceWorkflow', 'sample', 'version', 'mappedTables'],
		});
		sourceDataset = toReference(sourceDataset);
		sourceWorkflow = toReference(sourceWorkflow);

		if (sample !== undefined || version !== undefined) {
			if (!sourceDataset && !sourceWorkflow) {
				await this.get();
				sourceDataset = this.properties.sourceDataset?.qualifiedReference;
			}
			if (!sourceDataset || sourceWorkflow) {
				throw new ValueError(
					`${sample !== undefined ? 'Samples' : 'Versions'} aren't applicable to datasources that reference a workflow`,
				);
			}
			const isSample = sample ?? /:sample\b/.test(sourceDataset);
			sourceDataset = sourceDataset.replace(/:sample\b/, '');
			if (version !== undefined) {
				const tag = version instanceof Version ? version.tag : version;
				sourceDataset = new Dataset(sourceDataset, { version: tag }).qualifiedReference;
			}
			if (isSample) {
				sourceDataset += ':sample';
			}
		}

		if (Array.isArray(mappedTables)) {
			mappedTables = Object.fromEntries(
				mappedTables.map(([source, destination]) => [
					toScopedReference(source),
					toScopedReference(destination),
				]),
			);
		} else if (mappedTables !== undefined && !isPlainObject(mappedTables)) {
			throw new ValueError('mappedTables must be an array of [source, destination] pairs, or an object');
		}

		this._updateProperties(
			await makeRequest({
				method: 'PATCH',
				path: this.uri,
				payload: definedValues({ sourceDataset, sourceWorkflow, mappedTables }),
			}),
		);
		return this;
	}

	/**
	 * @returns {Promise<Dataset>} The source dataset. Throws a ValueError if the source is a workflow.
	 */
	async sourceDataset() {
		return this.#source('sourceDataset', Dataset, 'sourceWorkflow');
	}

	/**
	 * @returns {Promise<Workflow>} The source workflow. Throws a ValueError if the source is a dataset.
	 */
	async sourceWorkflow() {
		return this.#source('sourceWorkflow', Workflow, 'sourceDataset');
	}

	async #source(property, Class, otherMethod) {
		if (!this.properties?.[property]) {
			await this.get();
		}
		const properties = this.properties[property];
		if (!properties) {
			throw new ValueError(`This datasource doesn't have a ${property}. Use ${otherMethod}() instead.`);
		}
		return new Class(properties.qualifiedReference, { properties });
	}
}

function toReference(source) {
	return source instanceof Dataset || source instanceof Workflow ? source.qualifiedReference : source;
}

function toScopedReference(table) {
	return table instanceof Table ? table.scopedReference : table;
}
