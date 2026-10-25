import { makeRequest } from '../common/apiRequest.js';
import { NotFoundError } from '../common/errors.js';

// Shared behavior for every class that represents a Redivis resource. Subclasses set `uri` (and `properties`, once
//   they're known) in their constructor.
export default class Base {
	/**
	 * Returns a property of the resource, as populated by `get()` (or when the resource was listed or created).
	 * @param {string} property
	 */
	getProperty(property) {
		return this.properties?.[property];
	}

	toString() {
		return `<${this.constructor.name} ${this.qualifiedReference || this.name || this.uri}>`;
	}

	toJSON() {
		return this.properties ?? { uri: this.uri };
	}

	/**
	 * Whether the resource exists (and is visible to the current user).
	 * @returns {Promise<boolean>}
	 */
	async exists() {
		try {
			await makeRequest({ method: 'HEAD', path: this.uri });
			return true;
		} catch (e) {
			if (e instanceof NotFoundError) {
				return false;
			}
			throw e;
		}
	}

	/**
	 * Fetches the resource's properties.
	 * @returns {Promise<this>}
	 */
	async get() {
		this._updateProperties(await makeRequest({ method: 'GET', path: this.uri }));
		return this;
	}

	// Called with the API's representation of the resource whenever it's fetched, created, or updated
	_updateProperties(properties) {
		this.properties = properties;
		if (properties?.uri) {
			this.uri = properties.uri;
		}
	}
}
