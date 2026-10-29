# Changelog

Each release's section here becomes its notes on [GitHub](https://github.com/redivis/redivis-js/releases); see
[CONTRIBUTING.md](CONTRIBUTING.md#releases). Notes for releases before this file was added are on GitHub.

## Unreleased

## 0.4.1

### Fixes

- `version.tag` is now the version's tag as the API returns it, e.g. `v1.0`, rather than the form used in references
  (`v1_0`). `dataset.versionTag` and references are unchanged, and either form is still accepted wherever a tag is
  passed.

## 0.4.0

**This release brings the JavaScript client to feature parity with the [Python](https://github.com/redivis/redivis-python)
and [R](https://github.com/redivis/redivis-r) clients: reading data as Arrow tables, batches, rows, or streams;
non-tabular files; uploads; managing datasets, workflows, transforms, and notebooks; library-wide settings with
`redivis.config()`; typed errors; and TypeScript declarations. See the
[documentation](https://docs.redivis.com/api/client-libraries/redivis-js) for everything it can do, and
[Getting started](https://docs.redivis.com/api/client-libraries/redivis-js/getting-started) for migrating from 0.3.**

### Breaking changes

#### Installation and authentication

- Node.js 22 or later is required.
- The package is now an ES module only, with no CommonJS or UMD builds. `require('redivis')` still works in Node.js
  (22.12 and later). In the browser, use a bundler or load it from a CDN as an ES module
  (`https://cdn.jsdelivr.net/npm/redivis/+esm`).
- In Node.js, credentials are now cached in a file (`~/.redivis/js_credentials`) rather than in the system keychain,
  so you'll be prompted to log in again once after upgrading.

#### Reading data

- `table.listRows()` and `query.listRows()` are replaced by `toRowsArray()`. Alternatives are `toArrowTable()`,
  `toArrowBatchIterator()`, and `toReadStreams()`.
- `toRowsArray()` returns dates and dateTimes as [Temporal](https://tc39.es/proposal-temporal/docs/) values
  (`Temporal.PlainDate` and `Temporal.PlainDateTime`), and times as `Temporal.PlainTime`, rather than as `Date`s and
  seconds. Pass `temporal: false` to get `Date`s (and times as strings). Pass `bigInt: true` to get integers as BigInts
  rather than Numbers.
- The table `sample` option is removed. Reference the sample in the table's name instead, e.g.
  `dataset.table('name:sample')`.

#### Names and references

- Projects are now workflows: `user.project()` is now `user.workflow()`, and `table.project` is now `table.workflow`.
- `identifier` is replaced by `qualifiedReference` (with `scopedReference` for the reference within a dataset or
  workflow), and `dataset.version` by `dataset.versionTag`.
- A dataset without a version in its reference no longer defaults to `:current`. The API resolves it instead. Pass a
  version, e.g. `redivis.dataset('owner.name:current')` or `{ version: 'v1_0' }`, to pin one.
- `properties` (and so `getProperty()`) are only populated once they've been fetched from the API, e.g. by `get()`.
  They're no longer prefilled with the name and reference.

#### Options

- `dataset.createNextVersion()`'s `ignoreIfExists` option is renamed to `ifNotExists`.
- `workflow.listTables()`'s `includeDatasetTables` option is renamed to `includeDatasources`.
- Methods now throw a `ValueError` for options they don't recognize, rather than ignoring them.
