# Self-hosting Forge

## 1. Choose two hostnames

Use a Cloudflare account with an active DNS zone on which you can attach Worker Custom Domains. For example, use `forge.example.com` to serve artefacts and `manage.forge.example.com` for sign-in, administration and MCP. Pick unused names: conflicting DNS records may block Custom Domains. Do not put artefacts and management on one origin.

Install Node.js 24+, Git and OpenSSL. In **R2 Object Storage**, complete the R2 subscription checkout if prompted; the free usage allowance still applies. Workers Free is enough for light use; consider Paid for large publishes or maintenance workloads. Keep the Worker, D1, KV and R2 in the same account and keep the R2 bucket private (no `r2.dev`, bucket website or public custom domain).

## 2. Provision and configure

**Deploy button:** [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/go-silex/unkill-forge) is an alternative to manual provisioning. It uses [Workers Builds](https://developers.cloudflare.com/workers/platform/deploy-buttons/) to create a repository and provision the template's D1, R2 and KV bindings. Keep `npm run deploy` as the build's deploy command so it applies migrations before deploying the unrouted Worker. The fresh-instance walkthrough was verified using manual provisioning, not the button.

Clone the generated repository, run `npm ci` and `npx wrangler login`, and select the same Cloudflare account. Keep the generated bindings; do not provision duplicates. Disable the button-created automatic deployment before switching to the private CLI config. You still need to configure production vars, register an identity provider, set Worker secrets, install the R2 lifecycle rule, and attach both Custom Domains as described below.

**Manual provisioning:** clone the repository, `cd` into it, then run:

```sh
npm ci
npx wrangler login
npx wrangler d1 create forge
npx wrangler r2 bucket create forge-blobs
npx wrangler kv namespace create forge-oauth
```

If Wrangler offers to update the repository template, decline. Copy the IDs and bucket name from Wrangler's output, but keep the template binding names `DB`, `BLOBS` and `OAUTH_KV`. If you have multiple Cloudflare accounts, select the same account for each command and deployment; you can set `CLOUDFLARE_ACCOUNT_ID` in your local shell to select it. Do not commit that ID.

**Both paths:** work from the checkout (`npm ci` there if not already installed). Copy the populated `wrangler.jsonc` to a private path outside the repository, for example:

```sh
FORGE_CONFIG="$HOME/.config/forge/wrangler.jsonc"
mkdir -p "$(dirname "$FORGE_CONFIG")"
(umask 077; cp wrangler.jsonc "$FORGE_CONFIG")
```

Set `name` to your Worker name. Set the binding IDs/names and `FORGE_NAME`, `READ_ORIGIN`, `MANAGE_ORIGIN` and `ADMIN_EMAILS` in the private copy. Origins must be distinct canonical HTTPS origins, with no trailing slash. `ADMIN_EMAILS` is a comma-separated list of verified identity-provider email addresses; use one address you control for bootstrap. Leave `routes` empty until step 4. Keep `main` and `migrations_dir` relative to the checkout, not the private file. The deploy script temporarily copies the file to the checkout, applies pending D1 migrations by binding name, and deploys only after Wrangler confirms none remain.

In the checkout, add the required lifecycle rule using the bound bucket name (substitute it for `forge-blobs`):

```sh
npx wrangler r2 bucket lifecycle add forge-blobs upload-verification upload-verification/ --expire-days 1 -y
```

This is a **bucket** setting, not a Worker setting. Set it on fresh and upgraded deployments. Restrict it to `upload-verification/`: never add expiry to `blobs/`. Forge usually deletes verification copies itself; interrupted uploads can leave copies until lifecycle expiry. R2 deletion is asynchronous.

## 3. Register sign-in and set secrets

Register at least one confidential OAuth client. For a [GitHub OAuth App](https://github.com/settings/developers), set the homepage to `https://manage.forge.example.com` and the callback to `https://manage.forge.example.com/login/github/callback`. For [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials), create an OAuth client of type **Web application** and register `https://manage.forge.example.com/login/google/callback` as an authorized redirect URI. In another OIDC provider (for example, [Keycloak](https://www.keycloak.org/docs/latest/server_admin/#assembly-managing-clients_server_administration_guide)), enable the standard authorization-code flow for a confidential web client and register `https://manage.forge.example.com/login/<id>/callback`. The callback must be a GET with query parameters, not `form_post`. For OIDC providers supporting back-channel logout, register `https://manage.forge.example.com/login/<id>/backchannel-logout` as well. Enable `sid` in logout tokens if supported.

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

Google web clients use `client_secret_post`; the OIDC default is `client_secret_basic`. Match your provider's registered method. `hostedDomains` verifies Google's authenticated `hd` claim, not an email suffix; omit it for personal Google accounts. `requireClaims` checks exact claim values in **both** the ID token and UserInfo, so configure the provider to include them in both. Leave `autoJoinRole` unset to require admission or an invite. See [the sign-in spec](spec.md#10-sign-in-and-accounts) for all provider fields.

If the button did not already create the Worker, deploy it with no routes first:

```sh
npm run deploy -- --config "$FORGE_CONFIG"
```

Run `openssl rand -base64 32` twice to generate two independent keys. Save each value in your password manager under its own name **before** uploading it. Run the following and paste the saved value into each interactive prompt. Do not place secrets in command arguments, the config, or logs; use your Worker `name`, not the database name.

```sh
FORGE_WORKER=unkill-forge  # Replace with the configured Worker name
npx wrangler secret put FORGE_COOKIE_KEY --name "$FORGE_WORKER"
npx wrangler secret put FORGE_SEAL_KEY --name "$FORGE_WORKER"
npx wrangler secret put AUTH_GITHUB_CLIENT_SECRET --name "$FORGE_WORKER"
```

If you pipe a secret through stdin instead of using the prompt, pass only the saved value with no trailing newline: `tr -d '\n' < saved-file | npx wrangler secret put FORGE_SEAL_KEY --name "$FORGE_WORKER"`. Use a protected file and never put the secret in shell arguments or history.

The last command prompts for the OAuth client secret; GitHub asks you to confirm sudo mode (passkey or 2FA) before generating it. Repeat for every provider: use `AUTH_<ID>_CLIENT_SECRET`, uppercasing the ID and replacing non-alphanumerics with `_`, e.g. `AUTH_GOOGLE_CLIENT_SECRET`. Changing the cookie key invalidates signed read cookies. A restore needs the exact original seal key to reveal existing share keys; changing it does not revoke their URLs.

## 4. Open the instance and bootstrap

Set `routes` in the private config to the two hostnames (no scheme or path), matching the vars exactly:

```json
"routes": [
  { "pattern": "forge.example.com", "custom_domain": true },
  { "pattern": "manage.forge.example.com", "custom_domain": true }
]
```

Run `npm run deploy -- --config "$FORGE_CONFIG"` again. In Workers & Pages → your Worker → Settings → Domains & Routes, verify both Custom Domains are attached. Certificates may still be provisioning just after this deploy; if HTTPS fails, wait until both certificates are active and retry. Keep `workers_dev` and preview URLs off.

Add a Cloudflare Configuration Rule matching the **read hostname** and turn off Email Obfuscation, Rocket Loader and Automatic HTTPS Rewrites; they may rewrite HTML or cause Cloudflare to drop its strong ETags. Do not add zone-level cache rules that bypass Forge's access checks.

For the [Rulesets API equivalent](https://developers.cloudflare.com/rules/configuration-rules/create-api/), add a rule to the zone's `http_config_settings` entrypoint. Set the expression to `http.host eq "forge.example.com"` (substitute your read hostname), the action to `set_config`, and `action_parameters` to `{"email_obfuscation": false, "rocket_loader": false, "automatic_https_rewrites": false}`.

Set `ADMIN_EMAILS` **before** the intended admin ever signs in. The address needs to come from the provider as verified; GitHub uses only the primary verified address. On the manage origin, sign in with that new identity and confirm your admin role and the Members page. If that identity was already recorded as pending before bootstrap, changing `ADMIN_EMAILS` will not promote it on retry. Before anyone has bootstrapped, add another verified address and sign in with a not-yet-seen eligible provider identity; then approve or promote the original account from Members. After bootstrap, an existing admin must grant admin roles. A valid one-use invite beats OIDC auto-join; otherwise new members wait for approval. Invite URLs expire after seven days. Always keep an active admin. Removed members must get new sessions, OAuth grants and API tokens after reinstatement.

By default the read origin shows a landing page without a public catalogue. Set `PUBLIC_INDEX=true` to list public artefacts there and `ALLOW_INDEXING=true` to allow search indexing of public canonical URLs. Neither enables public access to private artefacts. To publish and verify the first private artefact, see [Connect and publish with MCP](mcp.md).

## Branding and locale

Set `LOCALE` to `en` (default) or `fr` for Forge-authored UI copy on both hosts. It does not translate published artefacts, provider labels or member names. `FORGE_NAME` sets the display name. `BRAND` is a JSON-encoded string; keep `"{}"` for the bundled defaults, or override the six-digit hex accent and the non-index read landing's plain text (up to 500 characters):

```json
{
  "FORGE_NAME": "Forge",
  "LOCALE": "fr",
  "BRAND": "{\"accent\":\"#a7481c\",\"landingText\":\"Our published work\"}"
}
```

To change the SVG logo or favicon, edit the trusted bundled assets in [`brand/defaults.ts`](../brand/defaults.ts) and rebuild; no template or CSP edits are needed.

## Upgrades, maintenance and backups

- **Upgrade:** read the [changelog](../CHANGELOG.md), back up, check that your private config includes the new vars or secrets, run `npm ci`, then `npm run deploy -- --config "$FORGE_CONFIG"`. Do not reapply numbered migrations manually; Wrangler records them. Do not run purge during a mixed-version rollout or roll back to an unfenced Worker. Disable the cron trigger before a rollout from an unfenced version and re-enable it only after the rollout is complete.
- **Older releases:** Gate 0 users reauthorize their MCP clients; anyone previously removed must sign in again after reinstatement, and previously removed bots need new tokens. During the `0004_invites.sql` rollout window, an old Worker may answer 409 to a successful removal; reload the member list before retrying. Before applying the share-link upgrade (`0007_share_links.sql`), set `FORGE_SEAL_KEY` and retain its backup. Add the R2 lifecycle rule when upgrading to uploads.
- **Admin UI and cron:** `0009_ui_flashes.sql` adds one-use notices and catalogue indexes; `0010_maintenance.sql` adds expiry indexes and maintenance progress. The deploy script applies both before activating the Worker. Flashes expire after two minutes; changing `FORGE_COOKIE_KEY` also makes pending sealed flashes unreadable.
- **Maintenance:** `0 3 * * *` means daily at 03:00 UTC. Check Workers Logs for `Forge maintenance` or recent Cron Events; a failed run reports task names only, and later runs retry unfinished work. Expiry removes metadata, not R2 blobs. Soft-deleted artefacts become eligible for purge after 30 days; completion depends on the backlog and artefact size. Scheduled maintenance also resumes registered admin purges. Do not rely on soft-deleted items as backups. See [architecture](architecture.md#maintenance) for the per-run rate.
- **Backup:** record a [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) bookmark and periodically export the database (e.g. `npx wrangler d1 export forge --remote --output "$HOME/forge-backup.sql"`; use your database name). Keep an encrypted copy of the private configuration and secrets, and independently copy the private R2 `blobs/` prefix to backup storage through the [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/). Protect exports like production data. KV holds OAuth state; plan to start with empty KV and reauthorize clients for a restore rather than recovering inconsistent grants. Do not assume a D1 snapshot restores R2 or KV.
- **Restore drill:** on an isolated Worker, restore D1 and the matching R2 objects, bind a fresh KV namespace, set the original seal key, register the drill callbacks and use different hostnames. Disable cron while inspecting the restored data. Verify member sign-in and representative private, public and shared files before relying on the backup. To get a consistent recovery point when possible, pause publishing and purge while taking the database and blob copies.
