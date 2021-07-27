import redivis from '../index.js';

async function runTests() {
	const queryRows = await redivis.query('SELECT 1+1').listRows();
	console.log(queryRows);

	const tableRows = await redivis
		.organization('demo')
		.dataset('Novel Corona Virus 2019 Dataset')
		.table('Covid 19 data')
		.listRows(10);

	console.log(tableRows);
}

runTests().catch(console.error);
