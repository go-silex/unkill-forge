# unkill-forge

Forge is a self-hosted service for publishing HTML artefacts at stable URLs, choosing who can read them, and working with them through remote MCP. It runs on Cloudflare Workers.

**Status: Phase 1.** Forge supports private and public artefacts, revocable share links, revision history, streamed uploads, and scheduled maintenance. The English/French manage UI covers artefacts, members, bots, tokens, redirects, restoration and purge. The runtime is **7,206 lines** under `src/`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/go-silex/unkill-forge)

## Quick start

1. Get a Cloudflare account with an active zone. Choose distinct read and manage hostnames. Install Node.js 24+.
2. Use the button to provision D1, R2 and KV, or create them manually using the [self-hosting guide](docs/self-hosting.md). Clone your checkout and run `npm ci`.
3. Copy `wrangler.jsonc` to a private file. Configure the bindings, origins, identity provider and a verified bootstrap address in `ADMIN_EMAILS`. Follow the guide to set Worker secrets, install the required `upload-verification/` R2 lifecycle rule and attach the two Custom Domains. The button does not do this configuration.
4. Run `npm run deploy -- --config /path/to/private/wrangler.jsonc` to apply migrations and deploy. Sign in at the manage origin with your bootstrap address and verify your admin role.
5. Open **Connect an agent** on the manage host or follow the [MCP guide](docs/mcp.md) to publish your first private page.

## Reference

- [Self-hosting](docs/self-hosting.md) — providers, deployment, branding and locale, upgrades and backups.
- [MCP](docs/mcp.md) — clients, tools and the binary upload recipe.
- [Architecture](docs/architecture.md) — the two origins, data model boundaries and maintenance.
- [Security and known limits](docs/security.md) — the trust model and operating constraints.
- [Product specification](docs/spec.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Report a vulnerability](SECURITY.md)

MIT, see [LICENSE](LICENSE).
