// Runs against the live Redivis API. Requires REDIVIS_API_TOKEN (and optionally REDIVIS_API_ENDPOINT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';

const skip = !process.env.REDIVIS_API_TOKEN && 'REDIVIS_API_TOKEN is not set';
const publicTable = 'demo.us_forest_service_fires:5k9t:v1_1.us_fire_perimeters:9r58';

test('runs a query', { skip }, async () => {
	const rows = await redivis.query('SELECT 1+1 AS two UNION ALL SELECT 3').toRowsArray();
	assert.deepEqual(rows.map(({ two }) => two).sort(), [2, 3]);
});

test('reads a public table', { skip }, async () => {
	const table = redivis.table(publicTable);
	assert.ok(await table.exists());

	const rows = await table.toRowsArray(10, { variables: ['FIRENAME', 'FIREYEAR'] });
	assert.equal(rows.length, 10);
	assert.deepEqual(Object.keys(rows[0]), ['FIRENAME', 'FIREYEAR']);

	const arrowTable = await table.toArrowTable(100);
	assert.equal(arrowTable.numRows, 100);
});

test('reads a large table through a parallel read session', { skip }, async () => {
	const table = redivis.table(publicTable);
	let rowsRead = 0;
	for await (const batch of table.toArrowBatchIterator({ variables: ['OBJECTID'], maxParallelization: 4 })) {
		rowsRead += batch.numRows;
	}
	await table.get();
	assert.equal(rowsRead, Number(table.getProperty('numRows')));
});

test('fetches the current user', { skip }, async () => {
	const user = await redivis.currentUser();
	assert.ok(user.name);
});
