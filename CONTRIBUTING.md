# Contributing

Use Node.js 24+. From the repository root:

```sh
npm ci
npm run lint
npm run check:file-length
npm run check:worker-scope
npm run knip
npm run typecheck
npm run test:node
npm run test:coverage
```

Tests run the Worker in `workerd` with isolated D1, R2 and KV bindings, not with a remote account. Add behaviour tests under `test/` when changing a policy or request flow. Use Biome for formatting and linting; CI requires the commands above to pass. Use Conventional Commit subjects (e.g. `fix: preserve revision metadata`) and update the changelog for user-facing changes.

Install local checks with `npx lefthook install`. Pre-push requires a clean
worktree and checks only pushes from `HEAD`, so every check sees the same
commit. Coverage floors in `config/coverage-floors.json` apply to first-party
JS/TS, including modules outside `src/`; test, tooling and build outputs are
excluded in `config/coverage-scope.json`. The checker requires a report record
for every in-scope file. Production and tooling source is capped at 300 lines;
entries in `config/file-length-exemptions.json` grandfather existing files
only. Split an overlong file instead of adding an entry or raising its cap.

The Worker scope check runs Wrangler's default-discovery dry run and inspects
its build metadata and attached modules. Keep exactly one root Wrangler config.
The check rejects output-name collisions and requires the upload entry bytes
to match esbuild's original output.

The scope gate checks the bundle produced by the allowed Wrangler configuration; keys that run commands or change module resolution are refused, and any change to the gate, its policy or that list relies on independent review.

The refused keys (at the root or in a named environment) are `alias`, `base_dir`,
`build`, `containers`, `data_blobs`, `find_additional_modules`, `no_bundle`,
`pages_build_output_dir`, `preserve_file_names`, `python_modules`, `rules`,
`site`, `text_blobs`, `unsafe`, and `wasm_modules`. They can run a build,
change module discovery or names, select a different packaging flow, or inject
files outside the JS/TS import graph.
Named environments must use the same Worker entry point as the root config.

These gates catch accidental drift. Deliberate evasion by a contributor with
write access—editing CI, gates, or policy, or crafting repo-controlled
execution—is covered by independent review, not by the gates.

The pre-install check refuses the root scripts npm can run during `npm ci`:
`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`,
`postprepare`, and `dependencies`. It also refuses `binding.gyp` (which can
trigger an implicit install script) and the `.npmrc` options `node-options`,
`script-shell`, and `onload-script`. CI and Lefthook invoke checks directly,
not through npm lifecycle wrappers.

Bundled first-party code must be in the length, coverage, and Knip scopes, even
outside `src/`. JSON imports and Wrangler attachments typed as data (for example,
text files) are exempt from source checks.

`npm run check:lockfile-cooldown` checks the working copy against the merge
base with `origin/main`. Pre-push checks the commits being pushed; set
`COOLDOWN_BASE` if the PR targets a different branch. CI checks each PR and
push before `npm ci`. `package-lock.json` must be a regular file and
`npm-shrinkwrap.json` is not permitted. Changed entries must match their npm
registry tarball and integrity and be at least three days old. A major change
at the same install path or a relocated release on a major line absent from
the base requires seven days instead.

For a deliberate age exception, add
`"package@version": {"reason": "why", "expires": "YYYY-MM-DD"}` to
`config/lockfile-cooldown-allowlist.json`. It expires at the start of that
UTC date; remove it before then. Exceptions never bypass artifact checks.
Have someone other than the author review changes to the CI workflow,
cooldown scripts, or exception list before merging; CI cannot enforce this
independence on its own.

## Schema changes

- Add a new numbered SQL file in `migrations/`; never change a migration that may already have been applied.
- Keep migrations additive and compatible with the previous Worker. Deployments apply schema changes before the new Worker receives traffic. Document any degraded behaviour during that window in the upgrade guide, and exercise both versions' write assumptions when needed.
- Always name target columns in `INSERT` statements, including test setup. Do not rely on table column order or on the absence of newly added columns.
- Keep test data synthetic. Do not commit account or binding IDs, private configuration, secrets, operational data, or importers and migration tooling for other systems. Versioned D1 schema migrations for Forge itself belong here.

Read the [spec](docs/spec.md) and [architecture](docs/architecture.md) before changing lifecycle or authorization.
