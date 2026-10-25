## redivis-js

JavaScript client library for [Redivis](https://redivis.com), for Node.js and the browser. Read data and metadata,
run queries, work with non-tabular files, upload data, and manage datasets and workflows. It mirrors the
[Python](https://github.com/redivis/redivis-python) and [R](https://github.com/redivis/redivis-r) clients, with
JavaScript conventions.

**[Read the documentation →](https://docs.redivis.com/api/client-libraries/redivis-js)**

```js
import redivis from 'redivis';

const table = redivis.table('demo.us_forest_service_fires:5k9t:v1_1.us_fire_perimeters:9r58');

// An array of row objects
const rows = await table.toRowsArray(100, { variables: ['FIRENAME', 'FIREYEAR'] });

// An Apache Arrow table
const arrowTable = await table.toArrowTable(1000);

// Or stream the rows, one arrow RecordBatch at a time
for await (const batch of table.toArrowBatchIterator()) {
	console.log(batch.numRows);
}

// Run a query
const counts = await redivis
	.query('SELECT FIREYEAR, COUNT(*) AS count FROM demo.us_forest_service_fires.us_fire_perimeters GROUP BY 1')
	.toRowsArray();
```

## Installation

```
npm install redivis
```

Node.js 20 or later is required. In the browser, the library is an ES module that a bundler resolves for you, or that
can be loaded from a CDN (`https://cdn.jsdelivr.net/npm/redivis/+esm`). Type declarations are included.

Public data can be read without authenticating; otherwise, the library prompts you to log in (in Node.js, or with a
popup in the browser), or uses the `REDIVIS_API_TOKEN` environment variable. See
[Getting started](https://docs.redivis.com/api/client-libraries/redivis-js/getting-started) for details.

## Documentation

- [Getting started](https://docs.redivis.com/api/client-libraries/redivis-js/getting-started): installation,
  authentication, and migrating from 0.3
- [Reference](https://docs.redivis.com/api/client-libraries/redivis-js/reference): every class and method
- Examples: [listing resources](https://docs.redivis.com/api/client-libraries/redivis-js/examples/listing-resources),
  [querying data](https://docs.redivis.com/api/client-libraries/redivis-js/examples/querying-data),
  [reading tabular data](https://docs.redivis.com/api/client-libraries/redivis-js/examples/reading-tabular-data),
  [uploading data](https://docs.redivis.com/api/client-libraries/redivis-js/examples/uploading-data),
  [working with non-tabular files](https://docs.redivis.com/api/client-libraries/redivis-js/examples/working-with-non-tabular-files),
  and [using in the browser](https://docs.redivis.com/api/client-libraries/redivis-js/examples/using-in-the-browser)

## Issues and contributing

Please report any issues or feature requests in the [issue tracker](https://github.com/redivis/redivis-js/issues).
See [CONTRIBUTING.md](CONTRIBUTING.md) for the library's conventions, and how to run its tests.
