import redivis from '../../index.js';

export default async function () {
	const a = Date.now()
	const query = redivis.query(`
		SELECT 1+1 AS two
	`);
	console.log(await query.listRows());
	console.log('Query took', Date.now() - a, 'ms');
}
