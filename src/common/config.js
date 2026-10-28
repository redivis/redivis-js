import { getEnv } from './node.js';
import { isPlainObject } from './args.js';
import { ValueError } from './errors.js';

// Each setting falls back to its environment variable (in Node) when it hasn't been set via config(), and then to its
//   default, if it has one. Environment variable names are always REDIVIS_ followed by the setting in SCREAMING_SNAKE_CASE.
const settings = {
	defaultWorkflow: { env: 'REDIVIS_DEFAULT_WORKFLOW', parse: parseReference },
	defaultDataset: { env: 'REDIVIS_DEFAULT_DATASET', parse: parseReference },
	defaultUser: { env: 'REDIVIS_DEFAULT_USER', parse: parseReference },
	defaultOrganization: { env: 'REDIVIS_DEFAULT_ORGANIZATION', parse: parseReference },
	apiEndpoint: { env: 'REDIVIS_API_ENDPOINT', parse: parseUrl, default: 'https://redivis.com/api/v1' },
	configDir: { env: 'REDIVIS_CONFIG_DIR', parse: parseString },
	maxParallelization: { env: 'REDIVIS_MAX_PARALLELIZATION', parse: parsePositiveInteger },
};

const overrides = {};

/**
 * Sets library-wide defaults, and returns the current configuration. Unset values fall back to their environment
 * variables (REDIVIS_DEFAULT_WORKFLOW, REDIVIS_API_ENDPOINT, etc.); pass `null` to clear a value that was previously set.
 *
 * @param {object} [options]
 * @param {string|object|null} [options.defaultWorkflow] Qualified reference of the workflow (`owner.workflow`) that
 *   unqualified table, query, parameter, transform, and notebook references resolve within
 * @param {string|object|null} [options.defaultDataset] Qualified reference of the dataset (`owner.dataset`) that
 *   unqualified table and query references resolve within, when there's no default workflow
 * @param {string|object|null} [options.defaultUser] Owner of unqualified dataset and workflow references
 * @param {string|object|null} [options.defaultOrganization] Owner of unqualified dataset and workflow references,
 *   when there's no default user
 * @param {string|null} [options.apiEndpoint] Base URL of the Redivis API. Defaults to `https://redivis.com/api/v1`
 * @param {string|null} [options.configDir] Directory where credentials are cached, in Node. Defaults to `~/.redivis`
 * @param {number|null} [options.maxParallelization] Default for the `maxParallelization` option of methods that read,
 *   upload, or download data in parallel. Each method has its own default when this isn't set
 * @returns {{defaultWorkflow?: string, defaultDataset?: string, defaultUser?: string, defaultOrganization?: string,
 *   apiEndpoint: string, configDir?: string, maxParallelization?: number}}
 */
export function config(options) {
	if (options !== undefined) {
		if (!isPlainObject(options)) {
			throw new ValueError('config() must be called with an object of settings');
		}
		for (const key of Object.keys(options)) {
			if (!(key in settings)) {
				throw new ValueError(
					`Unknown config option "${key}". Valid options are: ${Object.keys(settings).join(', ')}`,
				);
			}
		}
		// Validate everything before setting anything, so that an invalid value doesn't leave a partial update
		const parsed = Object.entries(options)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key, value === null ? null : settings[key].parse(value, key)]);
		for (const [key, value] of parsed) {
			if (value === null) {
				delete overrides[key];
			} else {
				overrides[key] = value;
			}
		}
	}
	return Object.fromEntries(Object.keys(settings).map((key) => [key, getConfigValue(key)]));
}

export function getConfigValue(key) {
	if (key in overrides) {
		return overrides[key];
	}
	const { env, parse, default: defaultValue } = settings[key];
	const envValue = getEnv(env);
	return envValue ? parse(envValue, env) : defaultValue;
}

// Accept class instances (e.g., redivis.workflow('owner.name')) as well as reference strings
function parseReference(value, name) {
	if (typeof value === 'string') {
		return parseString(value, name);
	}
	const reference = value?.qualifiedReference || value?.name;
	if (typeof reference !== 'string') {
		throw new ValueError(`${name} must be a reference string, or a Redivis object`);
	}
	return reference;
}

function parseString(value, name) {
	if (typeof value !== 'string' || !value) {
		throw new ValueError(`${name} must be a non-empty string`);
	}
	return value;
}

function parseUrl(value, name) {
	if (!/^https?:\/\/[^/]/.test(parseString(value, name))) {
		throw new ValueError(`${name} must be an http(s) URL, but got "${value}"`);
	}
	return value.replace(/\/+$/, '');
}

// Environment variables are strings, so these are also accepted
function parsePositiveInteger(value, name) {
	const number = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
	if (!Number.isInteger(number) || number < 1) {
		throw new ValueError(`${name} must be a positive integer, but got ${JSON.stringify(value)}`);
	}
	return number;
}
