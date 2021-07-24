// TODO: update construct, add statistics, getRows

export default class Variable {
	constructor(properties) {
		this.properties = properties;
		this.name = properties.name;
	}
	getProperty(prop) {
		return this.properties?.[prop];
	}
	toString() {
		return JSON.stringify(this.properties, null, 2);
	}
}
