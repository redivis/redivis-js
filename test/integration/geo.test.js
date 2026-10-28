// Geographic data, uploaded as GeoJSON. The JS client reads geography values as WKT strings.
import { sample, skip } from './live.js';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GEO_FEATURES, sortedBy } from './data.js';

const WKT_TYPES = { Point: 'POINT', LineString: 'LINESTRING', Polygon: 'POLYGON' };

// The coordinates in a WKT string, as [x, y] pairs
function wktCoordinates(wkt) {
	return [...wkt.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
}

// The [x, y] pairs in GeoJSON coordinates, however deeply they're nested
function geojsonCoordinates(coordinates) {
	return typeof coordinates[0] === 'number' ? [coordinates] : coordinates.flatMap(geojsonCoordinates);
}

function bounds(points) {
	const xs = points.map(([x]) => x);
	const ys = points.map(([, y]) => y);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

describe('geography', { skip }, () => {
	test('a geography variable', async () => {
		const variables = await (await sample.geo()).listVariables();

		assert.deepEqual(Object.fromEntries(variables.map((v) => [v.name, v.type])), {
			geometry: 'geography',
			name: 'string',
			value: 'integer',
		});
	});

	test('geography values are read as WKT', async () => {
		const rows = sortedBy(await (await sample.geo()).toRowsArray(), 'value');

		assert.deepEqual(
			rows.map(({ name, value }) => ({ name, value })),
			GEO_FEATURES.map(({ name, value }) => ({ name, value })),
		);
		for (const [i, { geometry }] of GEO_FEATURES.entries()) {
			const wkt = rows[i].geometry;
			assert.equal(typeof wkt, 'string');
			assert.ok(wkt.startsWith(WKT_TYPES[geometry.type]), wkt);
			// Edges may come back densified, as geodesics, so compare their extents
			const expected = bounds(geojsonCoordinates(geometry.coordinates));
			const actual = bounds(wktCoordinates(wkt));
			assert.ok(
				actual.every((value, j) => Math.abs(value - expected[j]) < 1e-6),
				`${wkt} has bounds ${actual}, rather than ${expected}`,
			);
		}
	});

	test('geography values can be queried', async () => {
		const geo = await sample.geo();

		const rows = await geo.dataset
			.query('SELECT name, ST_GEOMETRYTYPE(geometry) AS type FROM geo ORDER BY value')
			.toRowsArray();

		assert.deepEqual(
			rows.map(({ type }) => type),
			['ST_Point', 'ST_LineString', 'ST_Polygon'],
		);
	});
});
