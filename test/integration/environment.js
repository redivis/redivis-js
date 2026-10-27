// Which Redivis environment the integration tests run against, and the settings that control them. Everything is
//   configured through environment variables, since node's test runner doesn't take custom command-line options.
import { homedir } from 'node:os';

// Named environments that REDIVIS_TEST_ENV accepts, in addition to the URL of an API, with defaults for the settings
//   below. The dev environment's user accounts are limited to 50 datasets, so tests create theirs in an organization.
export const ENVIRONMENTS = {
	dev: {
		apiEndpoint: 'https://local.host:8443/api/v1',
		owner: 'demo',
		organization: 'demo',
	},
	prod: {
		apiEndpoint: 'https://redivis.com/api/v1',
	},
};
export const DEFAULT_ENVIRONMENT = 'dev';

// Variables that change how references resolve or how the client authenticates. A developer's shell (or a Redivis
//   notebook) may well set them, but the tests have to run the same regardless.
const AMBIENT_VARIABLES = [
	'REDIVIS_DEFAULT_USER',
	'REDIVIS_DEFAULT_ORGANIZATION',
	'REDIVIS_DEFAULT_WORKFLOW',
	'REDIVIS_DEFAULT_DATASET',
	'REDIVIS_DEFAULT_NOTEBOOK',
];

/**
 * The settings for this run, from REDIVIS_TEST_* environment variables and the environment's defaults.
 */
export function getSettings() {
	const environment = process.env.REDIVIS_TEST_ENV || DEFAULT_ENVIRONMENT;
	const defaults = resolveEnvironment(environment);
	return {
		environment,
		apiEndpoint: defaults.apiEndpoint,
		owner: process.env.REDIVIS_TEST_OWNER || defaults.owner,
		organization: process.env.REDIVIS_TEST_ORGANIZATION || defaults.organization,
		keepResources: isTruthy(process.env.REDIVIS_TEST_KEEP_RESOURCES),
		runSlow: isTruthy(process.env.REDIVIS_TEST_SLOW),
		configDir: getConfigDir(),
	};
}

function resolveEnvironment(environment) {
	if (ENVIRONMENTS[environment]) {
		return ENVIRONMENTS[environment];
	}
	if (/^https?:\/\//.test(environment)) {
		const apiEndpoint = environment.replace(/\/+$/, '');
		// A URL for a named environment gets its defaults too
		return Object.values(ENVIRONMENTS).find((settings) => settings.apiEndpoint === apiEndpoint) ?? { apiEndpoint };
	}
	throw new Error(
		`Unknown REDIVIS_TEST_ENV "${environment}": expected one of ${Object.keys(ENVIRONMENTS).join(', ')}, or an API URL`,
	);
}

// The client keeps each environment's credentials apart, in ~/.redivis/environments/<host>/, so they're only moved
//   elsewhere when asked to
function getConfigDir() {
	return process.env.REDIVIS_TEST_CONFIG_DIR?.replace(/^~(?=$|[\\/])/, homedir());
}

function isTruthy(value) {
	return !!value && !['0', 'false', 'no'].includes(value.toLowerCase());
}

/**
 * Points the client at the test environment. The client reads these variables whenever it makes a request, so this
 * must run before any request, but needn't run before the library is imported.
 */
export function applySettings(settings = getSettings()) {
	process.env.REDIVIS_API_ENDPOINT = settings.apiEndpoint;
	if (settings.configDir) {
		process.env.REDIVIS_CONFIG_DIR = settings.configDir;
	} else {
		delete process.env.REDIVIS_CONFIG_DIR;
	}
	for (const variable of AMBIENT_VARIABLES) {
		delete process.env[variable];
	}
	return settings;
}
