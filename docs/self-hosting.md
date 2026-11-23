# Self-hosting Forge

## 1. Choose two hostnames

Use a Cloudflare account with an active DNS zone on which you can attach Worker Custom Domains. For example, use `forge.example.com` to serve artefacts and `manage.forge.example.com` for sign-in, administration and MCP. Pick unused names: conflicting DNS records may block Custom Domains. Do not put artefacts and management on one origin.

Install Node.js 24+, Git and OpenSSL. Enable R2 in the Cloudflare dashboard. Workers Free is enough for light use; consider Paid for large publishes or maintenance workloads. Keep the Worker, D1, KV and R2 in the same account and keep the R2 bucket private (no `r2.dev`, bucket website or public custom domain).

## 2. Provision and configure

**Deploy button:** [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/go-silex/unkill-forge) creates a repository in your Git account, sets up Workers Builds and provisions `DB` (D1), `BLOBS` (R2) and `OAUTH_KV` (KV). Keep `npm run deploy` as the deploy command so it applies the schema before deploying. The first deploy deliberately has no public route. The button does not configure your Custom Domains, identity provider, production vars, Worker secrets or bucket lifecycle rule. Continue below with the generated repository and its populated bindings; do not provision duplicate resources. If switching to CLI deploys with a private config, disable automatic builds so a later template deploy cannot overwrite your routes or vars. See [Cloudflare's deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

**Manual provisioning:** clone the repository, `cd` into it, then run:

```sh
npm ci
npx wrangler login
npx wrangler d1 create forge
npx wrangler r2 bucket create forge-blobs
npx wrangler kv namespace create forge-oauth
```

Use the emitted D1 database ID and KV namespace ID, plus the R2 bucket name. If Wrangler offers to update the repository template, decline. If you have multiple Cloudflare accounts, select the same account for each command and deployment; you can set `CLOUDFLARE_ACCOUNT_ID` in your local shell to select it. Do not commit that ID.

**Both paths:** work from the checkout (`npm ci` there if not already installed). Copy the populated `wrangler.jsonc` to a private path outside the repository, for example:

```sh
FORGE_CONFIG="$HOME/.config/forge/wrangler.jsonc"
mkdir -p "$(dirname "$FORGE_CONFIG")"
(umask 077; cp wrangler.jsonc "$FORGE_CONFIG")
```

Set `name` to your Worker name. Set the binding IDs/names and `FORGE_NAME`, `READ_ORIGIN`, `MANAGE_ORIGIN` and `ADMIN_EMAILS` in the private copy. Origins must be distinct canonical HTTPS origins, with no trailing slash. `ADMIN_EMAILS` is a comma-separated list of verified identity-provider email addresses; use one address you control for bootstrap. Leave `routes` empty until step 4. Keep `main` and `migrations_dir` relative to the checkout, not the private file. The deploy script temporarily copies the file to the checkout, applies pending D1 migrations by binding name, then deploys.

In the checkout, add the required lifecycle rule using the bound bucket name (substitute it for `forge-blobs`):

```sh
npx wrangler r2 bucket lifecycle add forge-blobs upload-verification upload-verification/ --expire-days 1 -y
```

This is a **bucket** setting, not a Worker setting. Set it on fresh and upgraded deployments. Restrict it to `upload-verification/`: never add expiry to `blobs/`. Forge usually deletes verification copies itself; interrupted uploads can leave copies until lifecycle expiry. R2 deletion is asynchronous.

## 3. Register sign-in and set secrets

Register at least one confidential OAuth client with an identity provider. For the example manage host, the GitHub OAuth App homepage is `https://manage.forge.example.com` and the callback is `https://manage.forge.example.com/login/github/callback`. Replace `github` with the configured provider `id` for other providers. For OIDC providers supporting back-channel logout, register `https://manage.forge.example.com/login/<id>/backchannel-logout` as well. Enable `sid` in logout tokens if supported. Providers must return a verified email for bootstrap.

`AUTH_PROVIDERS` in Wrangler vars is a JSON-encoded **string** containing an array. The GitHub template needs only your client ID substituted. For Google or another OIDC provider, encode entries like these into that string (include only providers you registered):

```json
[
  {
    "id": "google",
    "type": "oidc",
    "label": "Google",
    "clientId": "your-google-client-id",
    "issuer": "https://accounts.google.com",
    "tokenAuthMethod": "client_secret_post",
    "hostedDomains": ["example.com"]
  },
  {
    "id": "team",
    "type": "oidc",
    "label": "Team SSO",
    "clientId": "your-oidc-client-id",
    "issuer": "https://id.example.com",
    "requireClaims": { "active_member": true },
    "autoJoinRole": "viewer"
  }
]
```

Google web clients use `client_secret_post`; the OIDC default is `client_secret_basic`. Match your provider's registered method. `hostedDomains` verifies the authenticated Google `hd` claim, not an email suffix; `requireClaims` checks exact claim values. Leave `autoJoinRole` unset to require admission or an invite. See [the sign-in spec](spec.md#10-sign-in-and-accounts) for all provider fields.

If the button did not already create the Worker, deploy it with no routes first:

```sh
npm run deploy -- --config "$FORGE_CONFIG"
```

Store two **different** high-entropy secrets. Pipe each directly to Wrangler, using your Worker `name` (and selected account), not the database name. Use your password manager or secret store to retain secure backups rather than printing secrets in logs or writing them to the config.

```sh
FORGE_WORKER=unkill-forge  # Replace with the configured Worker name
openssl rand -base64 32 | npx wrangler secret put FORGE_COOKIE_KEY --name "$FORGE_WORKER"
openssl rand -base64 32 | npx wrangler secret put FORGE_SEAL_KEY --name "$FORGE_WORKER"
npx wrangler secret put AUTH_GITHUB_CLIENT_SECRET --name "$FORGE_WORKER"
```

The last command prompts for the OAuth client secret. Repeat for every provider: use `AUTH_<ID>_CLIENT_SECRET`, uppercasing the ID and replacing non-alphanumerics with `_`, e.g. `AUTH_GOOGLE_CLIENT_SECRET`. Changing the cookie key invalidates signed read cookies. Changing the seal key does not revoke links but prevents Forge from revealing keys sealed with the old secret.

## 4. Open the instance and bootstrap

Set `routes` in the private config to the two hostnames (no scheme or path), matching the vars exactly:

```json
"routes": [
  { "pattern": "forge.example.com", "custom_domain": true },
  { "pattern": "manage.forge.example.com", "custom_domain": true }
]
```

Run `npm run deploy -- --config "$FORGE_CONFIG"` again. In Workers & Pages → your Worker → Settings → Domains & Routes, verify both Custom Domains are attached and certificates are active. Keep `workers_dev` and preview URLs off. Add a Cloudflare Configuration Rule matching the **read hostname** and turn off Email Obfuscation, Rocket Loader and Automatic HTTPS Rewrites; they may rewrite HTML or cause Cloudflare to drop its strong ETags. Do not add zone-level cache rules that bypass Forge's access checks.

Open the manage origin and sign in using the verified address you entered in `ADMIN_EMAILS`. Confirm that the instance shows your admin role and the Members page. Only the first eligible sign-in bootstraps an administrator. Afterwards a valid one-use invite beats OIDC auto-join, and otherwise new members wait for approval. In Members, create and copy an invite when shown; it expires after seven days. Always keep an active admin. Removed members must get new sessions, OAuth grants and API tokens after reinstatement.

The read origin serves an empty landing page until you publish, and lists public artefacts only with `PUBLIC_INDEX=true`. `ALLOW_INDEXING=true` separately permits search indexing of public canonical URLs. Neither enables public access to private artefacts. To publish and verify the first private artefact, see [Connect and publish with MCP](mcp.md).

## Upgrades, maintenance and backups

- **Upgrade:** read the [changelog](../CHANGELOG.md), back up, check that your private config includes the new vars or secrets, run `npm ci`, then `npm run deploy -- --config "$FORGE_CONFIG"`. Do not reapply numbered migrations manually; Wrangler records them. Do not run purge during a mixed-version rollout or roll back to an unfenced Worker. Disable the cron trigger before a rollout from an unfenced version and re-enable it only after the rollout is complete.
- **Older releases:** Gate 0 users reauthorize their MCP clients; anyone previously removed must sign in again after reinstatement, and previously removed bots need new tokens. During the `0004_invites.sql` rollout window, an old Worker may answer 409 to a successful removal; reload the member list before retrying. Before applying the share-link upgrade (`0007_share_links.sql`), set `FORGE_SEAL_KEY` and retain its backup. Add the R2 lifecycle rule when upgrading to uploads.
- **Maintenance:** `0 3 * * *` means daily at 03:00 UTC. Check Workers Logs for `Forge maintenance` or recent Cron Events; task failures are logged individually and retried on later runs. Expiry removes metadata, not R2 blobs. The purge task permanently deletes artefacts soft-deleted more than 30 days ago, and resumes registered admin purges; do not rely on soft-deleted items as backups. Limit details are in [architecture](architecture.md#maintenance).
- **Backup:** record a [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) bookmark and periodically export the database (e.g. `npx wrangler d1 export forge --remote --output "$HOME/forge-backup.sql"`; use your database name). Keep an encrypted copy of the private configuration and secrets, and independently copy the private R2 `blobs/` prefix to backup storage through the [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/). Protect exports like production data. KV holds OAuth state; plan to start with empty KV and reauthorize clients for a restore rather than recovering inconsistent grants. Do not assume a D1 snapshot restores R2 or KV.
- **Restore drill:** on an isolated Worker, restore D1 and the matching R2 objects, bind a fresh KV namespace, set the original seal key, register the drill callbacks and use different hostnames. Disable cron while inspecting the restored data. Verify member sign-in and representative private, public and shared files before relying on the backup. To get a consistent recovery point when possible, pause publishing and purge while taking the database and blob copies.
