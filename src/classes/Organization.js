import Dataset from './Dataset.js';

export default class Organization {
	constructor(name) {
		this.name = name;
	}

	dataset(name, options = {}) {
		return new Dataset({ name, ...options, organization: this });
	}
}
