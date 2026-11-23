# Contributing

Use Node.js 24+. From the repository root:

```sh
npm ci
npx biome ci .
npm run typecheck
npm test
```

Tests run the Worker in `workerd` with isolated D1, R2 and KV bindings, not with a remote account. Add behaviour tests under `test/` when changing a policy or request flow. Use Biome for formatting and linting; CI requires the commands above to pass. Use Conventional Commit subjects (e.g. `fix: preserve revision metadata`) and update the changelog for user-facing changes.

## Schema changes

- Add a new numbered SQL file in `migrations/`; never change a migration that may already have been applied.
- Keep migrations additive and compatible with the previous Worker. Deployments apply schema changes before the new Worker receives traffic. Document any degraded behaviour during that window in the upgrade guide, and exercise both versions' write assumptions when needed.
- Always name target columns in `INSERT` statements, including test setup. Do not rely on table column order or on the absence of newly added columns.
- Keep test data synthetic. Do not commit account or binding IDs, private configuration, secrets, operational data, or importers and migration tooling for other systems. Versioned D1 schema migrations for Forge itself belong here.

Read the [spec](docs/spec.md) and [architecture](docs/architecture.md) before changing lifecycle or authorization.
