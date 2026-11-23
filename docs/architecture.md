# Forge architecture

Forge is one Cloudflare Worker per team. `src/index.ts` validates configuration and dispatches by exact HTTPS origin before handling a request. The deploy template deliberately starts without public routes; [self-hosting](self-hosting.md) explains how to attach both origins with Custom Domains.

| Boundary                     | Responsibility                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read origin, `src/read/`     | Delivers published files and the landing page, serves `/a/<slug>/` and `/s/<slug>/<key>/`, and redeems private read handoffs. It never hosts management.                              |
| Manage origin, `src/manage/` | Sign-in, UI, OAuth and MCP, streamed upload ingress, and issuing read handoffs. It never serves artefact bytes.                                                                       |
| Core, `src/core/`            | Holds role and lifecycle policy, D1 queries, publish compare-and-set, guarded R2 I/O and scheduled maintenance. Adapters translate HTTP/MCP messages; they do not own the data model. |

| Binding        | What it stores                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1, `DB`       | Identity, membership, sessions, hashed credentials, artefact heads, revisions and files, upload receipts, links, aliases, auditing and purge state. It is the live authorization source. Versioned schema lives in `migrations/`. |
| R2, `BLOBS`    | Private bytes at `blobs/<sha256>`, shared across revisions and artefacts, plus transient `upload-verification/` copies with their own bucket lifecycle rule. There are no publicly readable object URLs.                          |
| KV, `OAUTH_KV` | OAuth client, grant and token state managed by the OAuth provider. KV is eventually consistent; live membership and OAuth replay/revocation checks are in D1.                                                                     |

## Request flows

1. **Read:** resolve an artefact or alias and enforce the requested canonical or share access mode in D1. For a missing private session, a top-level navigation hands off to the manage origin to sign in. The manage origin posts a single-use, browser-bound code back to the read origin. The read cookie is host-only and tied to the live manage session. A valid read resolves the file at the current head and streams it from R2 (single byte range when supported). Public conditional responses still recheck access; private and share content is not cached.
2. **Publish:** OAuth or an API token authenticates to the manage host, which rechecks current role. Inline bytes are hashed and stored in R2 first; alternatively a capability PUT streams and verifies a binary before `publish` can use its upload ID. One D1 batch checks slug ownership and head, writes the new revision and manifest, consumes upload IDs, advances the head, audits and prunes up to two outdated revisions. A retry never partially publishes a head. A retained revision can be restored by copying references, not bytes.
3. **Delete:** soft deletion immediately hides canonical and share reads and reserves the slug. An administrator can restore during the 30-day window if purge has not started. Renames and aliases bind to stable artefact IDs so old URLs do not resolve to an unrelated artefact that later reuses a slug.

## Manage UI

Server-rendered Hono pages share role-aware navigation. Active members browse `/artefacts` and its detail pages or connect a client at `/connect`. Publishers manage artefacts and their personal credentials (`/tokens`). Admin pages cover people, invites and roles (`/admin/members`), bots and bot tokens (`/admin/bots`), aliases (`/admin/redirects`) and deleted artefacts or purge progress (`/admin/deleted`). Sign-in, invite entry, pending access and OAuth consent are served on the same manage origin.

An artefact form submits the displayed stable ID with the slug. Most mutations redirect to a destination-bound, one-use D1 flash; only the continuation ID goes in the URL. A valid document navigation consumes it and can display a previously sealed secret. See [UI security](security.md#manage-ui-forms-and-one-use-notices) for the two-minute lifetime, access checks and referrer policy.

## Maintenance

The daily 03:00 UTC trigger calls core with a cutoff no later than the current time. A failed task does not stop later tasks. Logs contain task names and counts, not binding errors or credentials. Work advances in pages across runs; cleanup is not the authority for credential validity.

| Work                                                                                              | Cutoff and per-run limit                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login flows, handoffs, OAuth consents, UI flashes, sessions, uploads, invite contexts and invites | Up to 128 rows per table at or before their recorded expiry. Expire child rows first; defer parents with remaining children to avoid an unbounded cascade. Upload cleanup never deletes R2 objects.                                                                  |
| Identity revocations                                                                              | Up to 128 markers at least eight days old. This covers the seven-day OAuth grant cap plus authorization-code lifetime and clock margin. Browser session revocation is recorded directly on the session.                                                              |
| History                                                                                           | Visit at most 64 artefacts and prune up to two outdated live revisions in D1 per run. The live read/restore cutoff and at-publish pruning remain in force. Keep soft-deleted manifests until restore or purge so purge can stage their hashes.                       |
| Deleted artefacts                                                                                 | Visit up to eight artefacts with `deleted_at` strictly older than 30 days, register their purge jobs and advance up to four registered jobs, oldest attempt first. This also resumes explicit admin purges, including jobs that already removed their artefact rows. |

## Why purge has a fence

A registered job owns the slug across requests. Core stages hashes as it removes at most 256 manifest rows per step and likewise bounds each share, redirect and revision cleanup page. After hard deletion of the artefact, it processes at most 64 candidate hashes per step. A D1 transaction claims only hashes with no file or unexpired stored upload reference. While a claim is held, D1 prevents new references; a global epoch rejects a publish or upload verification that overlapped the purge even if the claim was released before commit. R2 deletion is attempted only for hashes the step still owns. Leases and durable candidates allow resuming a failed or interrupted job without losing the remaining work. Registration and completion are audited separately; scheduled steps have no human actor.

Pruning and upload expiry can leave orphaned bytes. There is no general blob garbage collector, and `upload-verification/` is outside the purge protocol. See [security and known limits](security.md#storage-and-purge) for failure modes and rollout constraints. For schemas, access rules and edge cases, read [the spec](spec.md).
