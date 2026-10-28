import { ValueError } from './errors.js';

export const isNode = typeof window === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node;

export function getEnv(name) {
	return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

// Guards functionality that needs Node (e.g., reading from or writing to the filesystem). Node modules must only
//   ever be loaded via importNodeModule() after this check, never with a static or literal import, so that the library
//   can still be bundled for the browser.
export function requireNode(feature) {
	if (!isNode) {
		throw new ValueError(`${feature} is only supported in Node.js environments`);
	}
}

// Loads a built-in Node module. The specifier is built at runtime (and flagged for webpack and Vite) so that bundlers
//   targeting the browser don't try to resolve it; a literal `import('node:fs')` fails to bundle there.
export function importNodeModule(name) {
	const specifier = `node:${name}`;
	return import(/* webpackIgnore: true */ /* @vite-ignore */ specifier);
}
