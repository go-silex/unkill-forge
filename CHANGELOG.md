# Changelog

## v2.2.0 — 2026-11-24

- Add a sign-in action to the read home page that opens the management host.
- Show cover images in the opt-in public catalogue and the authenticated Manage catalogue. Search, visibility filters and pagination are unchanged.
- Upgrade: no D1 migration or new binding. `PUBLIC_INDEX` still defaults to off.

## v2.1.1 — 2026-11-24

- Fold metadata under row names on narrow screens in the artefact share, personal token, member and deleted artefact tables.
- Upgrade: no D1 migration and no config change. Instance themes can style the folded values with `.forge-fold`.

## v2.1.0 — 2026-11-24

- Restyle Forge-authored pages with light and dark defaults, a responsive manage menu and tables, a configurable short brand label, and optional same-origin theme assets; read pages gain a restrictive CSP and the sign-in handoff permits same-origin styles and fonts without changing artefact delivery.
- Upgrade: no D1 migration. Existing instances need no config change; add a `THEME` assets binding and `BRAND` keys only to use a theme (see the self-hosting guide).

## v2.0.1 — 2026-11-23

- Use a verified email or the account subject as the OIDC revalidation hint, and retry once interactively when the provider requires it.
- Upgrade: apply D1 migration `0011` before or with the Worker deploy. If a silent revalidation started by the previous Worker returns an interaction error, that session ends once and the user needs to sign in again.

## v2.0.0 — 2026-11-23

- Self-host one Forge instance on Cloudflare Workers with D1, a private R2 bucket, KV and separate read and manage hosts.
- Sign in with GitHub, Google or an OIDC provider; manage membership, invites, bots and revocable API tokens.
- Publish, inspect, edit and restore HTML artefacts through remote MCP using OAuth or API tokens; stream larger files with single-use uploads.
- Deliver private and public canonical pages and revocable share links; keep old URLs on rename and recover soft-deleted artefacts before purge.
- Apply bounded daily expiry, history retention and resumable purge; follow the new deployment, MCP and security guides to run an instance.
