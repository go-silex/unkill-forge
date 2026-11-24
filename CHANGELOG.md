# Changelog

## Unreleased

- Use branded, localized cards for sign-in, invitations, access approval, OAuth consent and browser error pages. Search the public home by title or slug and see result counts and update dates; find agent setup in client-specific accordions on Connect. API protocols and security checks are unchanged.
- Ask for confirmation before deleting an artefact or starting an irreversible purge. A purge that's already underway can still be continued directly.
- Copy the MCP endpoint and command or configuration snippets from the Manage connection page.
- Open the artefact catalogue at the Manage home. Filter by access with catalogue-wide totals, see access badges and versions at a glance, and find sign-out in the navigation account block.
- Show relative dates in Manage with absolute timestamps on hover. Set the optional `TIMEZONE` to change the display zone; it defaults to UTC.
- Manage Private, Shared and Public access from one control on the artefact detail page. Copy the canonical address, manage individual share links, and browse or restore older versions from a timeline.
- Separate pending, active and removed people from invitation links on Members. Manage robot roles and credentials in a detail panel, see personal token and redirect metadata, and check how long a deleted artefact can still be restored. Open creation forms and destructive confirmations in native sheets.
- Reject stale Refuse and Remove confirmations if the member’s status changed after the sheet opened.
- Upgrade: no D1 migration, binding or required config change.

## v2.5.1 — 2026-11-24

- Start generating a missing HTML cover as soon as its revision is published, without delaying the response. The schedule remains available for retries and backfill.
- Upgrade: no D1 migration, binding or config change.

## v2.5.0 — 2026-11-24

- Show private artefacts with an active share link as "Shared" in the Manage catalogue, and add a Shared filter. The Private filter now lists private artefacts without an active link. Creating or revoking links moves an artefact between the two; the artefact visibility setting stays private/public.
- Upgrade: no D1 migration, binding or config change.

## v2.4.0 — 2026-11-24

- Offer grid and list views of the public catalogue and the Manage catalogue; the Manage list is a table with slug, visibility, revision and update time. `?view=list` selects the list and is kept across search and pagination.
- Move the public catalogue's sign-in action into the page header and open the Manage catalogue after sign-in. The catalogue no longer has a "Public artefacts" heading and says so when nothing is public yet.
- Send pending members who open an artefact, token or redirect page in Manage (as the public sign-in action now does) to the Manage home, which explains that approval is required, instead of a bare 403.
- Upgrade: no D1 migration, binding or config change. Instance themes can style `.forge-toolbar`, `.forge-views`, `.forge-gallery--list` and `.forge-thumb`.

## v2.3.0 — 2026-11-24

- On instances with Browser Run enabled, generate missing HTML catalogue covers in the background, including for already-published artefacts. A valid supplied cover takes precedence; no extra revision is created.
- Upgrade: deploy additive D1 migration `0012`. Opt in with the Browser Run binding and five-minute cover trigger described in the [self-hosting guide](docs/self-hosting.md).

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
