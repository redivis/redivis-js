import Organization from './src/classes/Organization.js';
import Query from './src/classes/Query.js';
import User from './src/classes/User.js';

export { authorize, deauthorize, isAuthorized, setApiProxy } from './src/common/auth.js';

export function organization(name) {
	return new Organization(name);
}

export function user(name) {
	return new User(name);
}

export function query(queryString) {
	return new Query(queryString);
}
