# Contributing

Use Node.js 24+. From the repository root:

```sh
npm ci
npm run lint
npm run check:file-length
npm run knip
npm run typecheck
npm run test:node
npm run test:coverage
```

Tests run the Worker in `workerd` with isolated D1, R2 and KV bindings, not with a remote account. Add behaviour tests under `test/` when changing a policy or request flow. Use Biome for formatting and linting; CI requires the commands above to pass. Use Conventional Commit subjects (e.g. `fix: preserve revision metadata`) and update the changelog for user-facing changes.

Install local checks with `npx lefthook install`. Pre-push runs the same quality
checks as CI. Coverage floors in `config/coverage-floors.json` apply to the
Worker and bundled brand code. Source files are capped at 300 lines; entries in
`config/file-length-exemptions.json` grandfather existing files only. Split an
overlong file instead of adding an entry or raising its cap.

On lockfile changes, `npm run check:lockfile-cooldown` checks the working copy
against the merge base with `origin/main`. Pre-push checks the commits being
pushed; set `COOLDOWN_BASE` if the PR targets a different branch. CI uses the
actual PR base and head. Versions must be at least three days old, or seven days
for a major version change. Document deliberate exceptions as
`"package@version": "reason"` in `config/lockfile-cooldown-allowlist.json`.

## Schema changes

- Add a new numbered SQL file in `migrations/`; never change a migration that may already have been applied.
- Keep migrations additive and compatible with the previous Worker. Deployments apply schema changes before the new Worker receives traffic. Document any degraded behaviour during that window in the upgrade guide, and exercise both versions' write assumptions when needed.
- Always name target columns in `INSERT` statements, including test setup. Do not rely on table column order or on the absence of newly added columns.
- Keep test data synthetic. Do not commit account or binding IDs, private configuration, secrets, operational data, or importers and migration tooling for other systems. Versioned D1 schema migrations for Forge itself belong here.

Read the [spec](docs/spec.md) and [architecture](docs/architecture.md) before changing lifecycle or authorization.
