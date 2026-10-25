// Runs against the live Redivis API. Requires REDIVIS_API_TOKEN (and optionally REDIVIS_API_ENDPOINT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import redivis from '../../index.js';

const skip = !process.env.REDIVIS_API_TOKEN && 'REDIVIS_API_TOKEN is not set';

test('runs a query', { skip }, async () => {
	const rows = await redivis.query('SELECT 1+1 AS two UNION ALL SELECT 3').listRows();
	assert.deepEqual(rows.map(({ two }) => two).sort(), [2, 3]);
});

test('reads a public table by its qualified reference', { skip }, async () => {
	const table = redivis.table('demo.us_forest_service_fires:5k9t:v1_1.us_fire_perimeters:9r58');
	const rows = await table.listRows(10);
	assert.equal(rows.length, 10);
	assert.ok(await table.exists());
});

test('fetches the current user', { skip }, async () => {
	const user = await redivis.currentUser();
	assert.ok(user.name);
});
