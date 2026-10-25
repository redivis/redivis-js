import Dataset from './Dataset.js';
import Workflow from './Workflow.js';

// TODO: list datasets
// TODO: list workflows

export default class User {
	constructor(name) {
		this.name = name;
	}

	dataset(name, options = {}) {
		return new Dataset({ name, ...options, user: this });
	}
	workflow(name, options = {}) {
		return new Workflow({ name, ...options, user: this });
	}
}
