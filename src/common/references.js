// Splits a reference like `owner.dataset:v1_0.table` into its dot-separated parts. A version tag can also be written
//   with a dot (`:v1.0`), so it's first normalized to the equivalent underscore form.
export function splitReference(reference) {
	return reference.replace(/:v(\d+)\.(\d+)/gi, ':v$1_$2').split('.');
}

// The entries of an object whose values aren't undefined, e.g. for a PATCH payload of only the options that were passed
export function definedValues(object) {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
