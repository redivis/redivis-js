import * as redivis from '../../index.js';

export default async function () {
	const table = redivis.user('imathews').dataset('a34ga').table('test');
	const rows = await table.listRows();
	console.log(rows.length);
}
