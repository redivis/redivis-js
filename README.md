## redivis-js
Javascript client library for Redivis, for use in Node and browser environments.
```js
import redivis from 'redivis';

const table = redivis.table('demo.us_forest_service_fires:5k9t:v1_1.us_fire_perimeters:9r58');

// An array of row objects
const rows = await table.toRowsArray(100, { variables: ['FIRENAME', 'FIREYEAR'] });

// An Apache Arrow table (https://arrow.apache.org/docs/js/), which other libraries (e.g., Arquero, DuckDB-Wasm,
//   Observable Plot) can read directly
const arrowTable = await table.toArrowTable(1000);

// Or stream the rows, one arrow RecordBatch at a time
for await (const batch of table.toArrowBatchIterator()) {
	console.log(batch.numRows);
}
```
## Installation
`npm install --save redivis`

## Documentation
Full documentation available at: https://apidocs.redivis.com/client-libraries/redivis-js