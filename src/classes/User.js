import Base from './Base.js';
import Dataset from './Dataset.js';
import Workflow from './Workflow.js';
import { parseArgs } from '../common/args.js';

export default class User extends Base {
	/**
	 * @param {string} name The user's username
	 * @param {object} [options]
	 * @param {object} [options.properties]
	 */
	constructor(...args) {
		super();
		const { name, properties } = parseArgs(args, ['name'], { allowed: ['properties'] });
		this.name = name;
		this.uri = `/users/${encodeURIComponent(name)}`;
		this.properties = { kind: 'user', userName: name, uri: this.uri, ...properties };
	}

	dataset(...args) {
		const { name, version } = parseArgs(args, ['name'], { allowed: ['version'] });
		return new Dataset(name, { version, user: this });
	}

	workflow(...args) {
		const { name } = parseArgs(args, ['name']);
		return new Workflow(name, { user: this });
	}
}
