import redivis from '../index.js';

async function runTests() {
	// const rows = await redivis
	// 	.organization('demo')
	// 	.dataset('Novel Corona Virus 2019 Dataset')
	// 	.table('Covid 19 data')
	// 	.listRows(10);
	const rows = await redivis.query('SELECT 1+1').listRows();
	console.log(rows);
}

runTests().catch(console.error);
