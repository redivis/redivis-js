import Organization from './src/classes/Organization.js';
import Query from './src/classes/Query.js';
import User from './src/classes/User.js';

import * as auth from './src/common/auth.js';

export const authorize = auth.authorize;
export const deauthorize = auth.deauthorize;
export const isAuthorized = auth.isAuthorized;
export const setApiProxy = auth.setApiProxy;

export function organization(name) {
	return new Organization(name);
}

export function user(name) {
	return new User(name);
}

export function query(queryString) {
	return new Query(queryString);
}

export default {
	authorize,
	deauthorize,
	isAuthorized,
	setApiProxy,
	organization,
	user,
	query,
};
