import { makeRequest } from '../common/apiRequest.js';

export default class Version {
	constructor(argName, options = {}) {
		if (typeof argName === 'object') {
			options = argName;
			argName = undefined;
		}
		const { tag = argName, dataset, properties } = options;
		this.dataset = dataset;
		this.tag = tag;
		this.identifier = `${(this.dataset.organization || this.dataset.user).name}.${this.dataset.name}:${this.tag}`;
		this.uri = `/datasets/${encodeURIComponent(this.identifier)}/versions/${this.tag}`;
		this.properties = properties;
	}

	getProperty() {
		return this.properties?.[property];
	}

	async get() {
		this.properties = await makeRequest({ method: 'GET', path: this.uri });
		this.uri = this.properties.uri;
		return this;
	}
}
