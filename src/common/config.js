import { getEnv } from './node.js';
import { isPlainObject } from './args.js';
import { ValueError } from './errors.js';

// Each setting falls back to its environment variable (in Node) when it hasn't been set via config()
const envVariables = {
	defaultWorkflow: 'REDIVIS_DEFAULT_WORKFLOW',
	defaultDataset: 'REDIVIS_DEFAULT_DATASET',
	defaultUser: 'REDIVIS_DEFAULT_USER',
	defaultOrganization: 'REDIVIS_DEFAULT_ORGANIZATION',
};

const overrides = {};

/**
 * Sets library-wide defaults, and returns the current configuration. Unset values fall back to their environment
 * variables (REDIVIS_DEFAULT_WORKFLOW, etc.); pass `null` to clear a value that was previously set.
 *
 * @param {object} [options]
 * @param {string|object|null} [options.defaultWorkflow] Qualified reference of the workflow (`owner.workflow`) that
 *   unqualified table, query, parameter, transform, and notebook references resolve within
 * @param {string|object|null} [options.defaultDataset] Qualified reference of the dataset (`owner.dataset`) that
 *   unqualified table and query references resolve within, when there's no default workflow
 * @param {string|object|null} [options.defaultUser] Owner of unqualified dataset and workflow references
 * @param {string|object|null} [options.defaultOrganization] Owner of unqualified dataset and workflow references,
 *   when there's no default user
 * @returns {{defaultWorkflow?: string, defaultDataset?: string, defaultUser?: string, defaultOrganization?: string}}
 */
export function config(options) {
	if (options !== undefined) {
		if (!isPlainObject(options)) {
			throw new ValueError('config() must be called with an object of settings');
		}
		for (const [key, value] of Object.entries(options)) {
			if (!(key in envVariables)) {
				throw new ValueError(
					`Unknown config option "${key}". Valid options are: ${Object.keys(envVariables).join(', ')}`,
				);
			}
			if (value === null) {
				delete overrides[key];
			} else if (value !== undefined) {
				// Accept class instances (e.g., redivis.workflow('owner.name')) as well as reference strings
				overrides[key] = typeof value === 'string' ? value : value.qualifiedReference || value.name;
			}
		}
	}
	return Object.fromEntries(Object.keys(envVariables).map((key) => [key, getConfigValue(key)]));
}

export function getConfigValue(key) {
	return key in overrides ? overrides[key] : getEnv(envVariables[key]) || undefined;
}
