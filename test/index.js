import * as redivis from '../index.js';
import testStreamRows from './node/streamRows.js';

// TODO: build out test suite
async function runTests() {
	// await redivis.authorize({ apiToken: process.env.REDIVIS_API_TOKEN });
	await testStreamRows();
	// const queryRows = await redivis.query('SELECT 1+1 as two UNION ALL SELECT 1+1').listRows();
	// console.log(queryRows);
	// //
	// const table = await redivis.organization('demo').dataset('Novel Corona Virus 2019 Dataset').table('Covid 19 data');
	//
	// const tableRows = await table.listRows(10, { variables: ['deaths'] });
	// console.log(tableRows);
	// const datasets = await redivis.organization('stanfordphs').listDatasets({ maxResults: 10 });
	// console.log(datasets);
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
