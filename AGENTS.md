# AGENTS.md

The JavaScript client for the [Redivis](https://redivis.com) API, published to npm as `redivis`. It runs in Node.js
and the browser, and mirrors the [Python](https://github.com/redivis/redivis-python) and
[R](https://github.com/redivis/redivis-r) clients, in camelCase.

[CONTRIBUTING.md](CONTRIBUTING.md) is the guide for people. It covers the library's conventions, the test suites, and
releasing in detail. This file adds what's useful to know when changing the code. The user-facing documentation lives
outside this repo, at https://docs.redivis.com/api/client-libraries/redivis-js.

## Commands

```sh
npm ci
npm run test:unit                       # Offline, in seconds. Run before finishing any change
npm run test:unit -- readRows.test.js   # One file (paths are relative to test/unit)
npm run build:types                     # Generates the type declarations into types/. Also run before finishing
npx prettier --write <changed files>    # Formats the code with the version pinned in package.json
npm pack --dry-run                      # Lists the files that would be published
```

The integration tests (`npm run test:integration`) need a running Redivis environment and a login for it, which
opens a browser. They take several minutes and create data, so only run them when asked.

## Layout

- `index.js`: the public API. It has a named export for each top-level function (`table()`, `dataset()`,
  `config()`, ...) and a default export object with the same members, so add new ones to both.
- `src/classes/`: a class for each kind of API resource (`Dataset`, `Table`, `Workflow`, ...), each a subclass of
  `Base`. Those with rows to read (`Table`, `Query`, `Upload`) extend `TabularReader`. A resource's `uri` is its API
  path, and its `properties` are what the API returned for it, which are `undefined` until `get()` is called.
- `src/common/`:
    - `apiRequest.js`: `makeRequest()` and `makePaginatedRequest()`, which handle retries, authentication, and API
      errors. All API calls go through these.
    - `args.js`: `parseArgs()`, for the `fn(...positional, options)` calling convention.
    - `auth.js`, `signInPrompt.js`: OAuth login (the device flow in Node, a popup in the browser), and the credentials
      cached for each environment.
    - `dpop.js`: in the browser, binds access tokens to a non-extractable key (DPoP, RFC 9449), kept in IndexedDB, and
      signs the proof that each request with such a token carries.
    - `config.js`: the library-wide settings behind `config()`.
    - `references.js`: parsing references like `owner.dataset:v1_0.table`.
    - `readRows.js`, `arrowTypes.js`, `rowsArray.js`: reading tables and queries into Arrow, and converting to rows.
    - `upload.js`, `download.js`, `files.js`: resumable uploads, verified downloads, and file index listings.
    - `errors.js`, `jobs.js`, `json.js`, `node.js`, `pool.js`: errors, waiting on jobs, JSON serialization of BigInts and
      Temporal values, Node detection and imports, and a concurrency-limited map.
- `test/unit/`: tests against a mocked `fetch`, from `helpers.js`.
- `test/integration/`: tests against a live API; see CONTRIBUTING.md.
- `test/browser/index.html`: a manual check that the library loads and reads public data in a browser
  (`npm run test:browser`).

## Conventions

CONTRIBUTING.md's Conventions section covers Node and browser support, argument parsing, types, and parity. In short,
and in addition:

- **Node and the browser**: use web APIs (`fetch`, `ReadableStream`, `Blob`, `crypto.subtle`), not Node's. Code that
  needs Node calls `requireNode()` first, and loads Node modules with `importNodeModule()` from `src/common/node.js`,
  never with a static or literal `import('node:...')`, so the library still bundles for the browser. Read environment
  variables with `getEnv()`, which returns `undefined` in the browser.
- **Arguments**: public methods take `(...args)` and normalize them with `parseArgs()`, passing the names of the
  positional arguments, and the `allowed` options and their `defaults`. It throws on unknown options, so list every
  option. A positional argument must never accept a plain object.
- **Errors**: throw the classes in `src/common/errors.js` (`ValueError`, `NotFoundError`, `JobError`, ...), not
  plain `Error`s, so users can catch them by class.
- **Settings**: read them when they're used, with `getConfigValue()`, never when a module is loaded. To add one, add
  it to `settings` in `config.js`, and to `config()`'s JSDoc. Its environment variable is `REDIVIS_<SCREAMING_SNAKE>`.
- **Types**: the declarations in `types/` are generated from JSDoc, and aren't committed. Document each public
  method's `...args` as a union of tuples (its positional and options-only forms), and its options as a `@typedef`.
  Mark internal methods, prefixed with `_`, as `@protected`. Check the output with `npm run build:types`.
- **Data**: Arrow (`apache-arrow`) is the core format. Integers that may exceed 2^53 must stay exact: serialize
  payloads with the replacer in `json.js`, and keep BigInts as BigInts until the user asks for Numbers. Dates and times
  are Temporal values, using `temporal-polyfill` (loaded lazily) where Temporal isn't built in.
- **Node versions**: Node 22 is the oldest supported version (`engines` in package.json). CI tests 22, 24, and 26.
- **Platforms**: CI also runs the unit tests on Windows and macOS. Build paths with `path` (via `importNodeModule`),
  don't assume `/` separators, and remember that Windows can't replace or delete a file that's still open.
- **Other clients**: the Python and R clients have the same API, e.g. `config()` matches Python's `redivis.config()`.
  Deprecated Python methods, and functionality specific to Redivis notebooks, aren't ported. When changing public
  behavior here, mention whether they need the same change.
- **Public API**: keep changes backwards compatible where possible. When a change is breaking, say so in the
  changelog, under "Breaking changes".
- **Formatting**: Prettier, configured in package.json (tabs, single quotes, 120 columns). CI doesn't check it, so
  format the files you change.

## Dependencies

The runtime dependencies are `apache-arrow` and `temporal-polyfill`, and the library is loaded in browsers, so keep it
small. Discuss before adding a dependency, and prefer web APIs or a few lines of code. Node built-ins are fine, through
`importNodeModule()`.

## Tests

- Prefer a unit test for the client's own logic, using `mockFetch()` and the response helpers in
  `test/unit/helpers.js`. Use an integration test only to check that the client and the API work together.
- Import `helpers.js` before the library in unit tests. It sets `REDIVIS_API_TOKEN` and a fake API endpoint, so that
  the tests never trigger a login or touch real credentials. Keep it that way in new tests.
- Integration tests must create what they modify, name it with `uniqueName()`, and wrap their tests in a `describe()`
  with `live.js`'s `skip` option. See CONTRIBUTING.md's "Writing tests".

## Changes, commits, and releases

- Describe every user-facing change under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), in the pull request that
  makes it, written for users, in the style of the existing notes. Its sections become the GitHub release notes.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `refactor:`,
  `test:`, `docs:`, `build:`, `chore:`), with a body saying what changed and why for anything non-trivial.
- Merging a change to the version in `package.json` into `main` publishes that version to npm. So don't change the
  version, create tags, or create GitHub releases unless asked. When asked, bump it with `npm version <x.y.z>`, which
  (per `.npmrc`) doesn't commit or tag.
- `.github/workflows/test.yml` runs the unit tests and the type build on pull requests, and `publish.yml` releases on
  pushes to `main`. Don't rename `publish.yml` or its `npm` environment: npm's trusted publishing names them. Check
  changes to the workflows with `actionlint`.
