import TabularReader from './TabularReader.js';
import Variable from './Variable.js';
import { makeRequest, makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { JobError } from '../common/errors.js';

export default class Query extends TabularReader {
	#initiation = null;
	#payload = null;

	/**
	 * Queries are lazy: the query isn't started until it's first used.
	 *
	 * @param {string} query The SQL query
	 * @param {object} [options]
	 * @param {string|object} [options.defaultWorkflow] Workflow (or its qualified reference) that unqualified table
	 *   references resolve within. Defaults to the configured defaultWorkflow.
	 * @param {string|object} [options.defaultDataset] Dataset (or its qualified reference) that unqualified table
	 *   references resolve within. Defaults to the configured defaultDataset.
	 */
	constructor(...args) {
		super();
		let { query, defaultWorkflow, defaultDataset } = parseArgs(args, ['query'], {
			allowed: ['defaultWorkflow', 'defaultDataset'],
		});
		if (!defaultWorkflow && !defaultDataset) {
			defaultWorkflow = getConfigValue('defaultWorkflow');
			defaultDataset = getConfigValue('defaultDataset');
		}
		const payload = { query };
		if (defaultWorkflow) {
			payload.defaultWorkflow = defaultWorkflow.qualifiedReference ?? defaultWorkflow;
		} else if (defaultDataset) {
			payload.defaultDataset = defaultDataset.qualifiedReference ?? defaultDataset;
		}
		this.#payload = payload;
		this.properties = {};
	}

	toString() {
		return `<Query ${this.properties.id || '[uninitiated]'}>`;
	}

	async get() {
		await this.#initiate();
		this._updateProperties(await makeRequest({ method: 'GET', path: this.uri }));
		return this;
	}

	async variable(...args) {
		const { name } = parseArgs(args, ['name']);
		await this._waitForFinish();
		return new Variable(name, { query: this });
	}

	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		await this._waitForFinish();
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { query: this, properties: variable }));
	}

	async _getFileSource() {
		await this._waitForFinish();
		return { query: this };
	}

	_getExportName() {
		const finishedAt = this.properties.finishedAt ? new Date(this.properties.finishedAt) : new Date();
		return `query_${finishedAt.toISOString().replace(/[.:]/g, '_')}`;
	}

	async _getReadInfo() {
		await this._waitForFinish();
		return {
			numRows: this.properties.outputNumRows,
			numBytes: this.properties.outputNumBytes,
			canListRows: true,
		};
	}

	// The query is only created once, however many callers are waiting on it
	#initiate() {
		if (!this.#initiation) {
			this.#initiation = makeRequest({ method: 'POST', path: '/queries', payload: this.#payload }).then(
				(properties) => this._updateProperties(properties),
			);
		}
		return this.#initiation;
	}

	_updateProperties(properties) {
		this.properties = properties;
		this.uri = properties.uri ?? `/queries/${properties.id}`;
	}

	async _waitForFinish() {
		await this.#initiate();
		while (true) {
			if (this.properties.status === 'completed') {
				break;
			} else if (this.properties.status === 'failed') {
				throw new JobError({ kind: 'query', status: 'failed', message: this.properties.errorMessage });
			} else if (this.properties.status === 'cancelled') {
				throw new JobError({ kind: 'query', status: 'cancelled', message: 'Query job was cancelled' });
			} else {
				await new Promise((resolve) => setTimeout(resolve, 2000));
				await this.get();
			}
		}
	}
}
