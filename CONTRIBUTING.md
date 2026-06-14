# Contributing to momo-agentic

This guide is for working **on** the library. If you're using the SDK, see the
[README](README.md).

## Requirements

- [Bun](https://bun.sh) 1.2+ (runtime, package manager, test runner)

## Development

```bash
bun install
bun test              # run tests
bun run test:coverage # tests with a coverage table
bun run test:report   # write reports/junit.xml + reports/coverage/lcov.info
bun run typecheck     # tsc --noEmit
bun run lint          # biome
bun run check         # format + typecheck + test (run before committing)
bun run ci            # non-mutating check (what CI runs): biome ci + typecheck + test
bun run build         # build to dist/ (ESM + CJS + .d.ts)
```

Code style is enforced by Biome (single quotes, no semicolons, trailing commas,
100-col). Don't format by hand — run `bun run format` or `bun run check`.

## Docs site

```bash
bun run docs        # build the TypeDoc site → ./site (open site/index.html)
bun run docs:watch  # rebuild on change
```

The site is generated from TSDoc comments plus an inline Examples page (built by
`scripts/build-examples-doc.ts`). When you add an example, also add it to that
script's `ITEMS` list. CI deploys the site to GitHub Pages on every push to `main`.

## Guards (don't break existing behavior)

Two test suites lock the public contract:

- [`src/public-api.test.ts`](src/public-api.test.ts) — every value/type export.
  When you intentionally add/rename/remove a public export, update this file in
  the same commit.
- [`src/regression.test.ts`](src/regression.test.ts) — behavioral invariants and a
  cross-feature integration.

CI runs on every push and PR ([.github/workflows/ci.yml](.github/workflows/ci.yml)):
lint + typecheck + tests, uploading the JUnit + coverage report as an artifact and
annotating the PR. A regression in the guards fails the build.

## Releasing

Changes are tracked in [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog format). To
cut a release:

1. Bump `version` in `package.json`.
2. Move the `[Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section.
3. Tag and push:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```

Pushing a `v*.*.*` tag triggers [.github/workflows/release.yml](.github/workflows/release.yml),
which verifies the tag matches `package.json`, runs the checks, builds,
**publishes a GitHub Release** (notes = that version's CHANGELOG section, npm
tarball attached), and **publishes to npm** with provenance.

### Publishing to npm — one-time setup

1. Create an npm **Automation** access token and add it as the repo secret
   `NPM_TOKEN` (Settings → Secrets and variables → Actions). Without it the release
   still publishes to GitHub but skips npm.
2. Tag a version (above) — the `npm-publish` job runs `npm publish --provenance --access public`.

To publish manually instead:

```bash
npm whoami || npm login
bun run build
npm publish        # uses publishConfig.access = "public"
```

The package ships only `dist/` (ESM + CJS + `.d.ts`), `README.md`, `CHANGELOG.md`,
and `LICENSE` — verify with `npm pack --dry-run`.
