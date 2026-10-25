## redivis-js

JavaScript client library for [Redivis](https://redivis.com), for Node and the browser. It mirrors the
[Python client](https://github.com/redivis/redivis-python), with JavaScript conventions.

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
```

## Installation

```
npm install redivis
```

Node 20 or later is required. In the browser, the library is an ES module; it depends on
[`apache-arrow`](https://www.npmjs.com/package/apache-arrow) (and, where `Temporal` isn't built in,
[`temporal-polyfill`](https://www.npmjs.com/package/temporal-polyfill)), which a bundler resolves for you.

Full documentation is available at https://apidocs.redivis.com/client-libraries/redivis-js.

## Authentication

Public data can be read without authenticating. When a resource requires it, the library authenticates automatically:

- **In Node**, it opens a browser to log in (falling back to printing a link), and caches the credentials in
  `~/.redivis` (or `REDIVIS_CONFIG_DIR`). Set `REDIVIS_API_TOKEN` to use an API token instead.
- **In the browser**, it shows a sign-in popup, and holds the (read-only, unless more is needed) token for the tab.

You can also call `await redivis.authorize()` up front, or `redivis.authorize({ apiToken })`. To keep credentials
off the client entirely, route requests through your own server with `redivis.setApiProxy(baseUrl)`.

## Conventions

- **Arguments**: every method takes its main arguments positionally, followed by an options object, and any positional
  argument can also be passed by name: `table.toArrowTable(100, { variables })` is the same as
  `table.toArrowTable({ maxResults: 100, variables })`. Unknown options throw, rather than being ignored.
- **Async**: methods that call the API return promises. Methods that only construct another object (e.g.
  `dataset.table(name)`) are synchronous, as are those that return a stream or iterator, which are lazy.
- **References**: resources can be referenced by name within their parent, or by their qualified reference:

    ```js
    redivis.organization('demo').dataset('my_dataset').table('my_table');
    redivis.table('demo.my_dataset:v1_0.my_table');
    redivis.workflow('jane.my_workflow').table('output');
    ```

    Defaults for unqualified references can be set with `redivis.config({ defaultWorkflow, defaultDataset,
defaultUser, defaultOrganization })`, and fall back to the `REDIVIS_DEFAULT_*` environment variables.

- **Progress and cancellation**: long-running methods take an `onProgress` callback and an `AbortSignal` (`signal`).
- **Errors** are instances of the classes in `redivis.errors`: `NotFoundError`, `AuthorizationError`, and `APIError`
  (with `status`, `code`, and `description`), `NetworkError`, `JobError`, and `ValueError`, all extending
  `RedivisError`.

## Reading data

Tables, queries, and uploads can all be read with:

| Method                                       | Returns                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------- |
| `toArrowTable(maxResults?, options)`         | an [arrow Table](https://arrow.apache.org/docs/js/)                           |
| `toRowsArray(maxResults?, options)`          | an array of row objects                                                       |
| `toArrowBatchIterator(maxResults?, options)` | an async iterator of arrow RecordBatches                                      |
| `toReadStreams(targetCount?, { variables })` | read streams, each readable with the methods above (e.g. in separate workers) |

Options include `variables` (the variables to read, in order), `maxParallelization`, `batchPreprocessor`,
`onProgress`, and `signal`.

```js
const query = redivis.query(`
	SELECT FIREYEAR, COUNT(*) AS count
	FROM demo.us_forest_service_fires.us_fire_perimeters
	GROUP BY FIREYEAR
`);
const rows = await query.toRowsArray();
```

`toRowsArray` returns dates, dateTimes, and times as `Temporal.PlainDate`, `Temporal.PlainDateTime`, and
`Temporal.PlainTime` (loading a polyfill where Temporal isn't built in), and integers as Numbers. Pass
`{ temporal: false }` for `Date`s (and time strings), or `{ bigInt: true }` for lossless integers.

**In the browser**, `toArrowTable` and `toRowsArray` read at most 100MB into memory by default; pass `maxBytes` to
change the limit, or stream larger reads with `toArrowBatchIterator`.

### Using other libraries

Arrow is widely supported, so an arrow Table can be handed to other tools directly:

```js
import * as aq from 'arquero';
const frame = aq.fromArrow(await table.toArrowTable());

import * as Plot from '@observablehq/plot';
Plot.dot(await table.toArrowTable(), { x: 'FIREYEAR', y: 'GISACRES' }).plot();

// DuckDB-Wasm
await connection.insertArrowTable(await table.toArrowTable(), { name: 'fires' });

// nodejs-polars
import { tableToIPC } from 'apache-arrow';
const df = pl.readIPC(Buffer.from(tableToIPC(await table.toArrowTable())));
```

## Files

For tables that index files (and queries over them):

```js
const directory = await table.toDirectory();
directory.list({ recursive: true });

const file = await table.file('images/a.png');
const bytes = await file.read();
const text = await file.read({ asText: true, startByte: 0, endByte: 99 });
const stream = file.stream();

// In Node
await file.download('./downloads/');
await directory.get('images').download('./images');
```

## Uploading data

```js
const table = redivis.organization('demo').dataset('my_dataset', { version: 'next' }).table('my_table');
await table.create();

// A Blob or File, ArrayBuffer, ReadableStream (with `size`), or file path (in Node)
await table.upload().create(file);

// Rows, or an arrow Table, are uploaded as newline-delimited JSON
await table.upload('rows').create([{ id: 1, name: 'a' }]);

// Files, for a file index table
await table.addFiles({ files: [fileA, { name: 'notes.txt', data: 'Hello' }] });
await table.addFiles({ directory: './images' }); // In Node
```

Uploads larger than 8MB are resumable, and are resumed automatically if interrupted.

## Exporting data

In Node, tables, queries, and uploads can be exported to files and downloaded:

```js
await table.download('./data/', { format: 'parquet' });
```

## Managing resources

Datasets, versions, tables, variables, workflows, datasources, transforms, notebooks, parameters, organization
members, and secrets can be created, listed, and updated with the same methods as the Python client, in camelCase:

```js
const dataset = await redivis.user('jane').dataset('my_dataset').create({ publicAccessLevel: 'overview' });
const next = await dataset.createNextVersion({ ifNotExists: true });
await next.update({ description: 'Updated', labelsToAdd: ['climate'] });
await next.release({ releaseNotes: 'Initial release' });

const workflow = redivis.workflow('jane.my_workflow');
const transform = await workflow.transform().create({ sourceTable: next.table('my_table'), query: 'SELECT 1' });
await transform.run();
```

## Node and the browser

Everything works in both, except for what needs a filesystem, which is Node only: downloading files and exports,
uploading from a file path, and adding the files of a local directory. These throw a `ValueError` in the browser.

## TypeScript

The package includes type declarations, generated from its JSDoc.

## Migrating from 0.3

- `listRows()` is replaced by `toRowsArray()`, which returns `Temporal` values for dates and times by default (pass
  `{ temporal: false }` for `Date`s).
- `identifier` is replaced by `qualifiedReference`, and `dataset.version` (the tag) by `dataset.versionTag`.
- Datasets no longer default to the `:current` version in their reference, and the table `sample` option is replaced
  by referencing `name:sample`.
- `createNextVersion({ ignoreIfExists })` is now `{ ifNotExists }`, and `listTables({ includeDatasetTables })` is now
  `{ includeDatasources }`.
- Errors are instances of the classes in `redivis.errors` (they still have a `status`).
- Unknown options throw a `ValueError`.
