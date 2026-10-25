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

`npm test` runs the offline test suite (in `test/offline`), which mocks the Redivis API.

`npm run test:live` runs the tests in `test/live` against the real API. They're skipped unless `REDIVIS_API_TOKEN` is
set.

To test within a browser environment, run `npm run test-browser`.

`npm run build:types` generates the type declarations (in `types/`, which isn't committed).

## Releases

Make sure you're logged in (`npm login`) and your working tree is clean, then run:

```
npm run release -- <patch|minor|major|x.y.z>
```

This bumps the version in `package.json` and `package-lock.json`, commits and tags it (`release vX.Y.Z`), pushes the
commit and tag, and publishes to npm (running the tests and building the type declarations first).
