import Base from './Base.js';
import Dataset from './Dataset.js';
import Variable from './Variable.js';
import Workflow from './Workflow.js';
import { makePaginatedRequest, makeRowsRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { ValueError } from '../common/errors.js';
import { splitReference } from '../common/references.js';

export default class Table extends Base {
	/**
	 * @param {string} name The table's name. If no dataset or workflow is given, this may be fully qualified
	 *   (`owner.dataset_or_workflow.table`), or else the table is resolved within the configured defaultWorkflow or
	 *   defaultDataset.
	 * @param {object} [options]
	 * @param {Dataset} [options.dataset]
	 * @param {Workflow} [options.workflow]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		let { name, dataset, workflow, properties } = parseArgs(args, ['name'], {
			allowed: ['dataset', 'workflow', 'properties'],
		});

		let referenceScope;
		let isWorkflowTable = false;
		const parts = splitReference(name);

		if (dataset) {
			referenceScope = dataset.qualifiedReference;
		} else if (workflow) {
			referenceScope = workflow.qualifiedReference;
			isWorkflowTable = true;
		} else if (parts.length === 3) {
			// Whether the container is a dataset or a workflow is resolved once we know more about the table
			referenceScope = `${parts[0]}.${parts[1]}`;
			name = parts[2];
			dataset = new Dataset(referenceScope);
			workflow = new Workflow(referenceScope);
		} else if (getConfigValue('defaultWorkflow')) {
			workflow = new Workflow(getConfigValue('defaultWorkflow'));
			referenceScope = workflow.qualifiedReference;
			isWorkflowTable = true;
		} else if (getConfigValue('defaultDataset')) {
			dataset = new Dataset(getConfigValue('defaultDataset'));
			referenceScope = dataset.qualifiedReference;
		} else {
			throw new ValueError(
				`Invalid table reference "${name}". It must be fully qualified (owner.dataset.table) if no dataset or workflow is specified.`,
			);
		}

		this.name = name;
		this.dataset = dataset;
		this.workflow = workflow;
		this.qualifiedReference = properties?.qualifiedReference ?? `${referenceScope}.${name}`;
		this.scopedReference = properties?.scopedReference ?? name;
		if (isWorkflowTable) {
			// Tables are resolved within their workflow, which also finds tables inherited through its datasources
			this.uri = `${workflow.uri}/tables/${encodeURIComponent(this.scopedReference)}`;
		} else {
			this.uri = `/tables/${encodeURIComponent(this.qualifiedReference)}`;
		}
		this.properties = properties;
	}

	variable(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Variable(name, { table: this });
	}

	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { table: this, properties: variable }));
	}

	async listRows(...args) {
		let { maxResults, variables } = parseArgs(args, ['maxResults'], { allowed: ['variables'] });

		await this.get();
		const mappedVariables = await this.listVariables();
		if (maxResults) {
			maxResults = Math.min(maxResults, this.properties.numRows);
		}

		let selectedVariables;
		if (variables?.length) {
			selectedVariables = variables.map((name) => {
				const variable = mappedVariables.find(
					({ name: variableName }) => variableName.toLowerCase() === name.toLowerCase(),
				);
				if (!variable) {
					throw new ValueError(`The variable ${name} was not found in this table`);
				}
				return variable.name;
			});
		}

		return makeRowsRequest({
			uri: this.uri,
			maxResults,
			mappedVariables,
			createReadSession: this.properties.numBytes > 1e8, // 100MB
			selectedVariables,
		});
	}

	_updateProperties(properties) {
		super._updateProperties(properties);
		this.qualifiedReference = properties.qualifiedReference;
		this.scopedReference = properties.scopedReference;
		this.name = properties.name;
		if (this.dataset && this.workflow && properties.container?.kind) {
			if (properties.container.kind === 'dataset') {
				this.workflow = undefined;
			} else {
				this.dataset = undefined;
			}
		}
	}

	// When the container came from a qualified reference, we don't know whether it's a dataset or a workflow until the
	//   API tells us (or we ask)
	async _rectifyAmbiguousContainer() {
		if (this.dataset && this.workflow) {
			if (await this.dataset.exists()) {
				this.workflow = undefined;
			} else {
				this.dataset = undefined;
			}
		}
	}
}
