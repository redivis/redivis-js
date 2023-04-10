import { nodeResolve } from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';

export default {
	external: ['keytar'],
	plugins: [json(), process.env.IS_LOCAL_TEST ? nodeResolve() : null].filter((plugin) => plugin),
};
