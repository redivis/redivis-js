import Organization from './src/classes/Organization.js';
import Query from './src/classes/Query.js';
import User from './src/classes/User.js';

function organization(name) {
	return new Organization(name);
}

function user(name) {
	return new User(name);
}

function query(name) {
	return new Query(name);
}

export default { organization, user, query };
