# Changelog

## Unreleased

- Restyle Forge-authored pages with light and dark defaults, a responsive manage menu and tables, a configurable short brand label, and optional same-origin theme assets; read pages gain a restrictive CSP and the sign-in handoff permits same-origin styles and fonts without changing artefact delivery.

## v2.0.1 — 2026-11-23

- Use a verified email or the account subject as the OIDC revalidation hint, and retry once interactively when the provider requires it.
- Upgrade: apply D1 migration `0011` before or with the Worker deploy. If a silent revalidation started by the previous Worker returns an interaction error, that session ends once and the user needs to sign in again.

## v2.0.0 — 2026-11-23

- Self-host one Forge instance on Cloudflare Workers with D1, a private R2 bucket, KV and separate read and manage hosts.
- Sign in with GitHub, Google or an OIDC provider; manage membership, invites, bots and revocable API tokens.
- Publish, inspect, edit and restore HTML artefacts through remote MCP using OAuth or API tokens; stream larger files with single-use uploads.
- Deliver private and public canonical pages and revocable share links; keep old URLs on rename and recover soft-deleted artefacts before purge.
- Apply bounded daily expiry, history retention and resumable purge; follow the new deployment, MCP and security guides to run an instance.
