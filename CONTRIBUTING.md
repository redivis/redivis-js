## Testing
`npm test` runs the offline test suite (in `test/offline`), which mocks the Redivis API.

`npm run test:live` runs the tests in `test/live` against the real API. They're skipped unless `REDIVIS_API_TOKEN` is set.

To test within a browser environment, run `npm run test-browser`

## Releases
Make sure you're logged in (`npm login`) and your working tree is clean, then run:

```
npm run release -- <patch|minor|major|x.y.z>
```

This bumps the version in `package.json` and `package-lock.json`, commits and tags it (`release vX.Y.Z`), pushes the commit and tag, and publishes to npm.