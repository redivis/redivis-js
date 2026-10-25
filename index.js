import Dataset from './src/classes/Dataset.js';
import Datasource from './src/classes/Datasource.js';
import Notebook from './src/classes/Notebook.js';
import Organization from './src/classes/Organization.js';
import Parameter from './src/classes/Parameter.js';
import Query from './src/classes/Query.js';
import Table from './src/classes/Table.js';
import Transform from './src/classes/Transform.js';
import User from './src/classes/User.js';
import Workflow from './src/classes/Workflow.js';

import * as auth from './src/common/auth.js';
import * as errors from './src/common/errors.js';
import { makeRequest } from './src/common/apiRequest.js';
import { config, getConfigValue } from './src/common/config.js';

export const authorize = auth.authorize;
export const deauthorize = auth.deauthorize;
export const isAuthorized = auth.isAuthorized;
export const setApiProxy = auth.setApiProxy;

export { config, errors };
export const makeApiRequest = makeRequest;

/**
 * @param {ConstructorParameters<typeof Organization>} args
 * @returns {Organization}
 */
export function organization(...args) {
	return new Organization(...args);
}

/**
 * @param {ConstructorParameters<typeof User>} args
 * @returns {User}
 */
export function user(...args) {
	return new User(...args);
}

/**
 * Returns a dataset, e.g. `redivis.dataset('owner.dataset_name')`.
 *
 * @param {ConstructorParameters<typeof Dataset>} args
 * @returns {Dataset}
 */
export function dataset(...args) {
	return new Dataset(...args);
}

/**
 * Returns a workflow, e.g. `redivis.workflow('owner.workflow_name')`.
 *
 * @param {ConstructorParameters<typeof Workflow>} args
 * @returns {Workflow}
 */
export function workflow(...args) {
	return new Workflow(...args);
}

/**
 * Returns a table, e.g. `redivis.table('owner.dataset_name.table_name')`.
 *
 * @param {ConstructorParameters<typeof Table>} args
 * @returns {Table}
 */
export function table(...args) {
	return new Table(...args);
}

/**
 * Returns a SQL query, which runs once its results are first read.
 *
 * @param {ConstructorParameters<typeof Query>} args
 * @returns {Query}
 */
export function query(...args) {
	return new Query(...args);
}

/**
 * @param {ConstructorParameters<typeof Datasource>} args
 * @returns {Datasource}
 */
export function datasource(...args) {
	return new Datasource(...args);
}

/**
 * @param {ConstructorParameters<typeof Parameter>} args
 * @returns {Parameter}
 */
export function parameter(...args) {
	return new Parameter(...args);
}

/**
 * @param {ConstructorParameters<typeof Transform>} args
 * @returns {Transform}
 */
export function transform(...args) {
	return new Transform(...args);
}

/**
 * @param {ConstructorParameters<typeof Notebook>} args
 * @returns {Notebook}
 */
export function notebook(...args) {
	return new Notebook(...args);
}

/**
 * Returns the currently authenticated user.
 * @returns {Promise<User>}
 */
export async function currentUser() {
	const properties = await makeRequest({ method: 'GET', path: '/users/me' });
	return new User(properties.name, { properties });
}

/**
 * Returns the configured default workflow (see `config()`), if any.
 * @returns {Workflow|null}
 */
export function currentWorkflow() {
	const defaultWorkflow = getConfigValue('defaultWorkflow');
	return defaultWorkflow ? new Workflow(defaultWorkflow) : null;
}

export default {
	authorize,
	deauthorize,
	isAuthorized,
	setApiProxy,
	config,
	errors,
	makeApiRequest,
	organization,
	user,
	dataset,
	workflow,
	table,
	query,
	datasource,
	parameter,
	transform,
	notebook,
	currentUser,
	currentWorkflow,
};
