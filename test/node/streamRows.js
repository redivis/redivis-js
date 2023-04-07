import * as redivis from '../../index.js';

export default async function () {
	const query = redivis.query(`
		SELECT 1+1 AS two
	`);
	console.log((await query.listRows()).length);
}
