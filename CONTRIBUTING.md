## Conventions

- **Node and the browser**: the library must run in both. Use web APIs (`fetch`, `ReadableStream`, `Blob`) rather than
  Node's. Functionality that needs Node (e.g. the filesystem) calls `requireNode()` first, and loads Node modules with
  `importNodeModule()` (from `src/common/node.js`), never with a static or literal `import('node:...')`, so that the
  library still bundles for the browser.
- **Arguments**: public methods follow the `fn(...positional, options)` convention, normalized with `parseArgs()`
  (from `src/common/args.js`), so that any positional argument can also be passed by name in the options. A positional
  argument must never accept a plain object.
- **Types**: the type declarations are generated from JSDoc. Document each public method's `...args` as a union of
  tuples (its positional and options-only forms), and its options as a `@typedef`. Mark internal methods (prefixed
  with `_`) as `@protected`.
- **Parity**: the API mirrors the [Python client](https://github.com/redivis/redivis-python), in camelCase. Deprecated
  Python methods, and functionality specific to Redivis notebooks, aren't ported.

## Testing

The tests use Node's built-in [test runner](https://nodejs.org/api/test.html) (`node:test` and `node:assert`), so
there's nothing to install beyond `npm install`. They live in two suites:

| Suite              | What it covers                                                                                       | Needs                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `test/unit`        | The client's own logic (requests, retries, auth, reading, uploads, downloads…), against a mocked API | Nothing; runs offline in seconds          |
| `test/integration` | End-to-end behavior against a live Redivis API, by uploading data and verifying what's read back     | A running environment, and a login for it |

```sh
npm test                    # Both suites, with the integration tests run against dev
npm run test:unit           # Just the unit tests
npm run test:integration    # Just the integration tests
npm run test:coverage       # The unit tests, with a coverage report of the library
```

Each script runs `node --test` from within its suite's directory, so files (relative to it) and Node's
[test runner options](https://nodejs.org/api/cli.html#--test) can be appended after `--`:

```sh
npm run test:unit -- readRows.test.js
npm run test:integration -- files.test.js uploads.test.js
npm run test:integration -- --test-name-pattern="upload"
```

Each test file runs in a process of its own, and files run in parallel (up to one fewer than your CPU cores; pass
`--test-concurrency` to change that). An integration test file can also be run with `node --test` directly, without
the global setup, in which case it sets up (and cleans up) its own sample data.

### Integration tests

#### Choosing an environment

By default, the integration tests run against the dev environment, at `https://local.host:8443`. Choose another with
the `REDIVIS_TEST_ENV` environment variable, which takes either the name of an environment or the URL of an API:

```sh
REDIVIS_TEST_ENV=prod npm run test:integration
REDIVIS_TEST_ENV=https://staging.example.com/api/v1 npm run test:integration
```

The named environments, and their defaults for the settings below, are defined by `ENVIRONMENTS` in
[`test/integration/environment.js`](test/integration/environment.js); add an entry there to name a new one. If an
environment's API can't be reached, its integration tests are skipped (and reported as such).

Node's `fetch` must trust the environment's TLS certificate. `npm run test:integration` runs Node with
`--use-system-ca`, so a certificate that your system trusts (e.g., one added to the macOS keychain, as the Python and
R clients also need) works as is. Otherwise, point `NODE_EXTRA_CA_CERTS` at the certificate, or at the authority that
signed it. When running a test file with `node --test` directly, pass `--use-system-ca` yourself.

#### Authenticating

The first time you run the integration tests against an environment, the client opens a browser to log in to it, as
it would for any user. The tests use their own config directory, `~/.redivis/test`, so that their credentials never
touch your own, even when testing against redivis.com. Within it, each environment's credentials are kept apart (e.g.,
the dev environment's in `~/.redivis/test/environments/local.host_8443/`). Set `REDIVIS_TEST_CONFIG_DIR` to keep them
somewhere else.

For a non-interactive run (e.g., in CI, where `CI` is set and the tests fail rather than wait for a login), provide an
API token for the environment instead:

```sh
REDIVIS_API_TOKEN=... REDIVIS_TEST_ENV=prod npm run test:integration
```

#### Test data

A fresh environment (like dev) has no data in it, so the tests upload their own. Before any test runs, the global
setup ([`test/integration/setup.js`](test/integration/setup.js)) creates a dataset of tables with known contents,
which the reading, query, and file tests verify their results against:

| Table   | Contents                                                                       | Uploaded as                   |
| ------- | ------------------------------------------------------------------------------ | ----------------------------- |
| `tiny`  | [`test/data/tiny.csv`](test/data/tiny.csv)                                     | A CSV file, by its path       |
| `typed` | A column of each scalar type, with nulls, a large integer, and awkward strings | An array of rows (JSON lines) |
| `geo`   | A point, a line, and a polygon                                                 | GeoJSON                       |
| `files` | A few files, including nested directories and a 3MB binary file                | Raw files, from a directory   |

Their expected contents are defined in [`test/integration/data.js`](test/integration/data.js). The uploads are
processed while the first tests run, and the tests that read a table wait for it, through `sample.tiny()` and the
like (from [`test/integration/live.js`](test/integration/live.js)). Tests that modify data create their own datasets
and tables, with `createDataset(t)` and `createTable(t)`, rather than touching these.

#### Cleanup

Everything the tests create lives in datasets and workflows named `jstest_<timestamp>_<random>_…`, owned by the test
owner (below). They're deleted as the tests that created them finish, and the sample dataset at the end of the run.
Set `REDIVIS_TEST_KEEP_RESOURCES=1` to leave them in place to inspect. Released datasets, and workflows, left behind by
an interrupted run are deleted by a later run once they're 12 hours old.

#### Settings

| Environment variable          | Purpose                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIVIS_TEST_ENV`            | The environment to test: a name from `ENVIRONMENTS`, or an API URL. Defaults to `dev`.                                                                                                                 |
| `REDIVIS_TEST_OWNER`          | The user or organization that owns the datasets the tests create. Defaults to the environment's default (`demo` for dev, whose user accounts are limited to 50 datasets), then the authenticated user. |
| `REDIVIS_TEST_ORGANIZATION`   | An organization the test user belongs to, for the organization tests. Defaults to the environment's default (`demo` for dev); the tests are skipped without one.                                       |
| `REDIVIS_TEST_KEEP_RESOURCES` | Don't delete the datasets the tests create.                                                                                                                                                            |
| `REDIVIS_TEST_SLOW`           | Also run the slow tests, such as a large upload from a file.                                                                                                                                           |
| `REDIVIS_TEST_CONFIG_DIR`     | The config directory to use, which holds the test environment's credentials. Defaults to `~/.redivis/test`.                                                                                            |

The tests also unset any `REDIVIS_DEFAULT_*` variables in your environment, so that they run the same everywhere.

### Writing tests

- Prefer a unit test, against the mocked `fetch` in [`test/unit/helpers.js`](test/unit/helpers.js), for anything about
  the client's own logic: how it builds requests, retries, authenticates, or handles a particular response. They're
  fast and deterministic, and can simulate failures that a live API can't.
- Use an integration test to verify that the client and the API work together: that data survives a round trip, that
  a workflow behaves end to end, and so on. Assert on the data that comes back, compared with what was uploaded, rather
  than just that a call didn't throw.
- Integration tests may run against any environment, and in parallel, so they can't depend on existing data or on each
  other. Import [`live.js`](test/integration/live.js) first, wrap the file's tests in a `describe()` with its `skip`
  option (so that they're skipped when the environment is unreachable), create what you need with its fixtures, and
  name anything else you create with `uniqueName()`.
- Tests within a file run one at a time, unless its `describe()` sets `concurrency: true` (as the slower files do,
  since each of their tests creates everything it modifies).
- Rows come back in no particular order, so sort them before comparing (see `sortedBy()` in `data.js`, and
  `readSorted()` in `helpers.js`).
- Mark a test that's known to fail because of an API bug with `{ todo: '<the bug>' }`, so that it still runs (and is
  reported), without failing the run. Skip a slow test unless `settings.runSlow` is set.

### In the browser

`npm run test:browser` serves the repository and opens [`test/browser/index.html`](test/browser/index.html), which
reads public data from redivis.com in the browser, and prints the results.

`npm run build:types` generates the type declarations (in `types/`, which isn't committed).

## Releases

Describe each user-facing change under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the pull request that
makes it. The [test workflow](.github/workflows/test.yml) runs the unit tests, and builds the type declarations, on
each pull request into `main`.

To release, bump the version with `npm version <patch|minor|major|x.y.z>`, which updates `package.json` and
`package-lock.json` (but, per `.npmrc`, doesn't commit or tag them), and rename `## Unreleased` in CHANGELOG.md to the
version (e.g., `## 0.4.0`), adding a new, empty `## Unreleased` section above it. Then merge that into `main`. For a
pre-release, use a version like `0.4.0-rc.1`; it's published under npm's `next` tag, so npm only installs it when asked
for it explicitly. Run the integration tests before releasing, too.

On each push to `main`, the [publish workflow](.github/workflows/publish.yml) checks whether there's a `v<version>`
tag for that version. If not, it runs the unit tests, publishes the package to npm, and then creates a GitHub release
for the version, which also creates its tag. The release's notes are the version's section of CHANGELOG.md; if there
isn't one, the workflow fails before publishing anything. npm trusts the workflow directly (trusted publishing), so no
access token is needed, and each version is published with a provenance attestation. Don't create release tags
yourself: a tag for the version means it's already been released.

If the workflow fails, fix the problem and re-run it from the Actions tab. Re-running it is safe even after the
publish to npm succeeded.

To check the package locally, run `npm run build:types && npm pack --dry-run`, which lists the files it would publish.
