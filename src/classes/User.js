import Dataset from './Dataset.js';
import Project from './Project.js';

export default class User {
	constructor(name) {
		this.name = name;
	}

	dataset(name, options = {}) {
		return new Dataset({ name, ...options, user: this });
	}
	project(name, options = {}) {
		return new Project({ name, ...options, user: this });
	}
}
