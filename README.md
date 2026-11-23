# unkill-forge

Forge is a self-hosted service for publishing HTML artefacts at stable URLs, controlling who can read them, and working with them through remote MCP. It runs on Cloudflare.

**Phase 1:** this build delivers public and private artefacts, revocable share links, revision history and restore, rename redirects, and soft deletion. MCP also supports publishing, editing, reading and streamed binary uploads. Sign-in, member administration and bot administration are available; deleted-artefact restoration and hard purge are core-only until the admin UI adds them. See [the specification](docs/spec.md).

The runtime is 5,162 lines under `src/`.

## Configure sign-in

Register Forge with each identity provider. The callback URL for provider ID `github`, `google` or any custom ID is `https://<manage>/login/<id>/callback`. If the OIDC provider supports back-channel logout, register `https://<manage>/login/<id>/backchannel-logout` too.

Set `AUTH_PROVIDERS` to a JSON-encoded array in your Wrangler configuration, for example:

```json
[
  { "id": "github", "type": "github", "label": "GitHub", "clientId": "github-client-id" },
  {
    "id": "google",
    "type": "oidc",
    "label": "Google",
    "clientId": "google-client-id",
    "issuer": "https://accounts.google.com",
    "tokenAuthMethod": "client_secret_post",
    "hostedDomains": ["example.com"]
  },
  {
    "id": "team",
    "type": "oidc",
    "label": "Team SSO",
    "clientId": "oidc-client-id",
    "issuer": "https://id.example.com",
    "requireClaims": { "active_member": true },
    "autoJoinRole": "viewer"
  }
]
```

Store each client's secret in Wrangler, not in the file: `AUTH_GITHUB_CLIENT_SECRET`, `AUTH_GOOGLE_CLIENT_SECRET` and `AUTH_TEAM_CLIENT_SECRET` in this example. The variable name uses the uppercased ID with non-alphanumeric characters replaced by `_`. Set `FORGE_COOKIE_KEY` to a high-entropy secret of at least 32 characters.

For OIDC, `tokenAuthMethod` defaults to `client_secret_basic`. Set `client_secret_post` for Google or any client registered for POST. A registration accepts its configured method even when discovery lists both.

The first eligible verified address in `ADMIN_EMAILS` can bootstrap an administrator, once per instance. Afterwards, a valid invite takes precedence over OIDC `autoJoinRole`. Without either, new members are pending until an administrator admits them.

In **Members**, choose a role and create an invite link. Copy it when it appears: it is shown once, expires after seven days, and admits one new or pending member when they open it and sign in. Admins can revoke unused links from the same page.

Only an admin can reinstate a removed member. Reinstatement restores the role, not access for old sessions, OAuth grants, or API tokens. Sign in again, authorize MCP clients again, or issue new API tokens as appropriate. Keep an active administrator to manage access.

## Configure the read host

Set `PUBLIC_INDEX=true` to list public artefacts on the read host landing page. Set `ALLOW_INDEXING=true` to allow search engines to index public artefacts. Both default to `false`.

Private reads use a separate host-only cookie signed with the existing `FORGE_COOKIE_KEY`. Signing out, revoking the manage session or removing the member ends private read access on the next request.

Share links let anyone with the URL read the current artefact without signing in, even when it is private. Revocation stops access through the link on the next request, even when the artefact is public. Treat the URL as a bearer secret: share it only with intended recipients and exclude share paths from request logs where possible.

Set `REVISION_RETENTION` to keep a different number of revisions per artefact (default `20`, max `100`). Rename redirects preserve canonical and share paths. Deleted artefacts return 404 and reserve their slug; administrators can restore them for 30 days unless purge has started. Timed D1 cleanup is tracked in [issue #11](https://github.com/go-silex/unkill-forge/issues/11).

## Deploy

1. Install Node.js 24+ and run `npm ci`.
2. Provision a D1 database, an R2 bucket and a KV namespace. Copy `wrangler.jsonc` to a private file and set its resource bindings (including the `BLOBS` bucket name), provider settings, custom domains and matching HTTPS origins; leave `main` and `migrations_dir` relative to this checkout.
3. **Required on new installs and when upgrading to uploads:** set a one-day R2 expiration rule on verification copies. Replace `<bucket>` with the `BLOBS` bucket name.

   ```sh
   npx wrangler r2 bucket lifecycle add <bucket> upload-verification upload-verification/ --expire-days 1 -y
   ```

   The rule is bucket-level; `npm run deploy` does not install it. R2 deletes expired copies asynchronously.

4. Set the secrets on the target Worker (`npx wrangler secret put <NAME> --config <private path>`). Keep `ALLOW_DCR` off unless a required client demonstrably needs it.
   Set the required `FORGE_SEAL_KEY` with a separate high-entropy secret of at least 32 characters: `openssl rand -base64 32 | npx wrangler secret put FORGE_SEAL_KEY --config <private path>`. Keep a secure backup: changing this secret does not invalidate links but prevents Forge from revealing keys sealed with the previous secret.
5. Run `npm run deploy -- --config <private path>`. The script temporarily copies the private configuration into the checkout so Wrangler resolves its paths there, applies the remote D1 migrations, then deploys.
6. In Cloudflare, add a Configuration Rule matching the read hostname. Turn off Email Obfuscation, Rocket Loader and Automatic HTTPS Rewrites for that hostname. These features can rewrite HTML artefacts and cause Cloudflare to drop their strong ETags.
7. Open the manage origin and sign in as the bootstrap administrator.

Existing Gate 0 databases apply `0002_oauth_code_redemption.sql` to add replay tracking. It also works if the redemption table was already created manually.

After deploying with `0004_invites.sql`:

1. Anyone whose membership was ever removed must sign in again after reinstatement. Sessions created by the previous Worker between migration and rollout also require signing in again.
2. Reissue API tokens for any bot that was ever removed, including tokens issued after a Gate 0 reinstatement. Tokens for other bots are unaffected.
3. Reauthorize all OAuth clients. Gate 0 grants cannot be exchanged, refreshed, or used on MCP.
4. Between the migration and the Worker rollout, the previous Worker can answer HTTP 409 to a member removal that did succeed. Reload the member list to confirm.

Before upgrading to the share-link release, set `FORGE_SEAL_KEY` on the target Worker. Migration `0007_share_links.sql` adds the shares table and a nullable revision entry path. Existing revisions populate their entry path when first needed.

Migration `0008_redirects.sql` adds redirects and purge bookkeeping, including leases so interrupted purge batches can be retried. The previous Worker can still publish and serve content after migration. Do not run purge during mixed-version rollout or roll back with an active purge.

## Connect an agent

- **Claude and Codex:** Use their native CIMD support with the Streamable HTTP URL `https://<manage>/mcp`, then sign in and approve the request.
- **OMP:** Use the Forge-hosted CIMD document with a loopback callback:

  ```json
  {"type":"http","url":"https://<manage>/mcp","oauth":{"clientId":"https://<manage>/oauth/clients/local.json","redirectUri":"http://127.0.0.1:3000/callback"}}
  ```

  Consent shows this generic client as an unverified local application and shows the loopback port.

- **Hermes:** Create a bot and token under **Bots and API tokens**, copy the token when shown, and send `Authorization: Bearer fgt_<token>` to the same `/mcp` URL.
- For browser-based MCP clients, add their exact HTTPS origins to the optional comma-separated `MCP_ALLOWED_ORIGINS`. Leave it unset for clients that do not send an `Origin` header.

OAuth access tokens last up to one hour and are shortened near the grant's seven-day cap. Codes are single-use: overlapping exchanges revoke the grant, and only a confirmed KV rate limit before the code is consumed permits retrying it. Access tokens without `grantId` are refused.

MCP tools:

- `whoami`: check the connected identity, role and instance URLs.
- `list_artefacts`, `get_artefact`, `read_file`: find artefacts, inspect files and read revision-specific text.
- `publish`: merge or replace files with inline UTF-8, base64 or stored upload IDs. New artefacts are private.
- `create_uploads`: prepare single-use capability URLs for binary or large files.
- `edit_file`: replace literal text at an expected revision; stale edits fail without changing the artefact.
- `set_visibility`: change an artefact between private and public without creating a revision.
- `create_share_link`, `list_share_links`, `get_share_link`, `revoke_share_link`: publishers and admins can create, inspect, copy or revoke links for any artefact. Only create and get reveal the full URL; only admins may supply a custom key.
- `list_revisions`, `restore_revision`: list retained history or create a new revision using an older revision's files.
- `rename_artefact`, `delete_artefact`: move the slug and retain old URLs, or hide the artefact via soft deletion.
- `set_redirects`: administrators add or remove aliases to live artefacts.

## Upload binary or large files

1. Call `create_uploads` with the target `slug` and `files: [{path, size, sha256, contentType?}]`. Give the file size in bytes and its lowercase SHA-256 hash. The optional `contentType` controls how the read host serves the file.
2. For each URL returned, upload the local file within 15 minutes. Skip files marked `alreadyStored: true`.

   ```sh
   curl -T file -H 'Content-Type: application/octet-stream' "$upload_url"
   ```

3. Within an hour of storage, call `publish` for the same slug with the returned `{path, uploadId}` entries. Keep upload URLs private; PUT needs no additional authentication.

Use `MAX_UPLOAD_BYTES` in Wrangler vars to lower the per-file limit from its default and maximum of `100000000` bytes (100 MB).

## Known limits

- Purge retries use a 15-minute lease. If an R2 delete remains outstanding beyond the lease and the same bytes are republished after a successor releases the claim but before the original delete lands, the late delete can remove the newly published object.

## License

MIT, see [LICENSE](LICENSE).
