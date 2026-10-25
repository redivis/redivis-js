import Dataset from './src/classes/Dataset.js';
import Organization from './src/classes/Organization.js';
import Query from './src/classes/Query.js';
import Table from './src/classes/Table.js';
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

export function organization(...args) {
	return new Organization(...args);
}

export function user(...args) {
	return new User(...args);
}

export function dataset(...args) {
	return new Dataset(...args);
}

export function workflow(...args) {
	return new Workflow(...args);
}

export function table(...args) {
	return new Table(...args);
}

export function query(...args) {
	return new Query(...args);
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
	currentUser,
	currentWorkflow,
};
