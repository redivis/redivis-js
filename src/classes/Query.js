import TabularReader from './TabularReader.js';
import Variable from './Variable.js';
import { makeRequest, makePaginatedRequest } from '../common/apiRequest.js';
import { parseArgs } from '../common/args.js';
import { getConfigValue } from '../common/config.js';
import { JobError } from '../common/errors.js';

/** @typedef {import('../common/args.js').ListArgs} ListArgs */
/** @typedef {import('../common/args.js').NameArgs} NameArgs */

/**
 * @typedef {object} QueryOptions
 * @property {string | import('./Workflow.js').default} [defaultWorkflow] Workflow (or its qualified reference) that
 *   unqualified table references resolve within. Defaults to the configured `defaultWorkflow`.
 * @property {string | import('./Dataset.js').default} [defaultDataset] Dataset (or its qualified reference) that
 *   unqualified table references resolve within. Defaults to the configured `defaultDataset`.
 */

export default class Query extends TabularReader {
	#initiation = null;
	#payload = null;

	/**
	 * A SQL query. Queries are lazy: the query isn't run until it's first used (e.g., by reading its results).
	 *
	 * @param {[query: string, options?: QueryOptions] | [options: QueryOptions & {query: string}]} args
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

	/**
	 * Runs the query, if it hasn't been run yet, and fetches its properties (including its status).
	 * @returns {Promise<this>}
	 */
	async get() {
		await this.#initiate();
		this._updateProperties(await makeRequest({ method: 'GET', path: this.uri }));
		return this;
	}

	/**
	 * Returns one of the query's output variables, once the query finishes.
	 *
	 * @param {NameArgs} args
	 * @returns {Promise<Variable>}
	 */
	async variable(...args) {
		const { name } = parseArgs(args, ['name']);
		await this._waitForFinish();
		return new Variable(name, { query: this });
	}

	/**
	 * Lists the query's output variables, once the query finishes.
	 *
	 * @param {ListArgs} args
	 * @returns {Promise<Variable[]>}
	 */
	async listVariables(...args) {
		const { maxResults } = parseArgs(args, ['maxResults']);
		await this._waitForFinish();
		const variables = await makePaginatedRequest({ path: `${this.uri}/variables`, pageSize: 1000, maxResults });
		return variables.map((variable) => new Variable(variable.name, { query: this, properties: variable }));
	}

	/** @protected @returns {Promise<{query: Query}>} */
	async _getFileSource() {
		await this._waitForFinish();
		return { query: this };
	}

	/** @protected */
	_getExportName() {
		const finishedAt = this.properties.finishedAt ? new Date(this.properties.finishedAt) : new Date();
		return `query_${finishedAt.toISOString().replace(/[.:]/g, '_')}`;
	}

	/**
	 * @protected
	 * @param {{maxResults?: number | null, variables?: string[], allowListRows?: boolean}} [options]
	 */
	async _getReadInfo({ maxResults, variables, allowListRows = false } = {}) {
		// A read that runs the query asks for the rows along with it, which the API returns if the query finishes quickly.
		//   Variables are validated once the query has run, so invalid ones are left for that to report.
		const selectedVariables = Array.isArray(variables) && variables.length ? variables.map(String) : undefined;
		const rowsResponse = await this.#initiate(
			allowListRows
				? {
						maxResults: maxResults ?? undefined,
						selectedVariables,
						format: 'arrow',
						eosSentinel: true,
					}
				: undefined,
		);
		if (rowsResponse) {
			return { canListRows: true, rowsResponse };
		}
		await this._waitForFinish();
		// When the query responded with its rows, we don't yet know its size
		if (this.properties.outputNumBytes === undefined) {
			await this.get();
		}
		return {
			numRows: this.properties.outputNumRows,
			numBytes: this.properties.outputNumBytes,
			canListRows: true,
		};
	}

	// The query is only created once, however many callers are waiting on it. With `listRows`, the caller that creates
	//   it gets the response containing its rows, if the API returned them rather than the query.
	#initiate(listRows) {
		if (this.#initiation) {
			return this.#initiation.then(() => undefined);
		}
		this.#initiation = makeRequest({
			method: 'POST',
			path: '/queries',
			payload: { ...this.#payload, listRows },
			parseResponse: false,
		}).then(async (response) => {
			// Content-Location is the URI of the rows, and Location that of the query
			if (!response.headers.get('content-location')) {
				this._updateProperties(await response.json());
				return undefined;
			}
			const id = response.headers.get('location').split('/').pop();
			this._updateProperties({ kind: 'query', id, uri: `/queries/${id}`, status: 'completed' });
			return response;
		});
		return this.#initiation;
	}

	/** @protected */
	_updateProperties(properties) {
		this.properties = properties;
		this.uri = properties.uri ?? `/queries/${properties.id}`;
	}

	/** @protected */
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
