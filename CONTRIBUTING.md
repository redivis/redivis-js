## Testing
To test within a node environment, run `npm run test`

To test within a browser environment, run `npm run test-browser`

## Releases
Make sure you're logged in (`npm login`) and your working tree is clean, then run:

```
npm run release -- <patch|minor|major|x.y.z>
```

This bumps the version in `package.json` and `package-lock.json`, commits and tags it (`release vX.Y.Z`), pushes the commit and tag, and publishes to npm.