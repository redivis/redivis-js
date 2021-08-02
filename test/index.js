import * as redivis from '../index.js';

// TODO: build out test suite
async function runTests() {
	// const queryRows = await redivis.query('SELECT 1+1').listRows();
	// console.log(queryRows);
	//
	// const table = await redivis.organization('demo').dataset('Novel Corona Virus 2019 Dataset').table('Covid 19 data');
	//
	// const tableRows = await table.listRows(10);
	//
	// console.log(tableRows);
	//
	// const tables = await redivis.user('demo').dataset('Google Community Mobility Reports').listTables();
	// console.log(tables);
	//
	// const variable = table.variable('snao');
	// await variable.exists().then(console.log);
}

runTests().catch(console.error);
