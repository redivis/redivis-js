import redivis from '../../index.js';

export default async function () {
	// const query = redivis.query(`
	// 	SELECT 1+1 AS two
	// `);
	// console.log(await query.listRows());
	const table = redivis
		.user('imathews')
		.project('example_project_climate_analysis:x7kh')
		.table('join_lat_lon_output:qvzg"');

	const a = Date.now();
	const res = await table.listRows(1);
	console.log('took', Date.now() - a);
}
