import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
	external: ['keytar'],
	plugins: process.env.IS_LOCAL_TEST ? [nodeResolve()] : [],
};
