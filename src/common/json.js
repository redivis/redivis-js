/**
 * A JSON.stringify replacer that represents values JSON doesn't support: BigInts as numbers (losslessly, where
 * JSON.rawJSON is available), and Temporal values as ISO strings (as Dates already are).
 */
export function jsonReplacer(key, value) {
	if (typeof value === 'bigint') {
		if (typeof JSON.rawJSON === 'function') {
			return JSON.rawJSON(value.toString());
		}
		return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	}
	// Not every Temporal polyfill implements toJSON
	if (value && typeof value === 'object' && /^Temporal\./.test(value[Symbol.toStringTag])) {
		return value.toString();
	}
	return value;
}
