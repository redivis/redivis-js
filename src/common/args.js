import { ValueError } from './errors.js';

/**
 * The arguments of a method that lists resources: `(maxResults?)` or `({ maxResults? })`.
 * @typedef {[maxResults?: number | null] | [options?: {maxResults?: number | null}]} ListArgs
 */

/**
 * The arguments of a method that takes a single name: `(name)` or `({ name })`.
 * @typedef {[name: string] | [options: {name: string}]} NameArgs
 */

// Normalizes the arguments of a method that follows the `fn(...positional, options)` convention, where every
//   positional argument can also be passed by name in the trailing options object. E.g., with positional
//   ['maxResults'], `fn(10, { variables })` and `fn({ maxResults: 10, variables })` both return
//   `{ maxResults: 10, variables }`.
//
// An option is valid if it's positional, has a default, or is listed in `allowed`; anything else is rejected, so that
//   a misspelled option fails loudly rather than being silently ignored.
//
// NB: since a trailing plain object is always treated as the options, a positional parameter must never accept a
//   plain object itself (arrays, Blobs, arrow Tables, class instances, etc. are fine).
export function parseArgs(args, positional = [], { defaults = {}, allowed = [] } = {}) {
	args = [...args];
	while (args.length && args.at(-1) === undefined) {
		args.pop();
	}

	const options = args.length && isPlainObject(args.at(-1)) ? { ...args.pop() } : {};

	if (args.length > positional.length) {
		throw new ValueError(
			`Expected at most ${positional.length} positional argument${positional.length === 1 ? '' : 's'}${
				positional.length ? ` (${positional.join(', ')})` : ''
			}, but received ${args.length}`,
		);
	}

	const validNames = new Set([...positional, ...Object.keys(defaults), ...allowed]);
	for (const name of Object.keys(options)) {
		if (!validNames.has(name)) {
			throw new ValueError(`Unknown option "${name}". Valid options are: ${[...validNames].join(', ')}`);
		}
	}

	positional.forEach((name, i) => {
		const value = args[i];
		if (value === undefined) return;
		if (options[name] !== undefined && options[name] !== value) {
			throw new ValueError(`"${name}" was passed both as an argument and as an option, with different values`);
		}
		options[name] = value;
	});

	for (const [name, value] of Object.entries(defaults)) {
		if (options[name] === undefined) {
			options[name] = value;
		}
	}

	return options;
}

export function isPlainObject(value) {
	if (value === null || typeof value !== 'object') {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
