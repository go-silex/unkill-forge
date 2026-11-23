# unkill-forge

Forge is a self-hosted service for publishing HTML artefacts at stable URLs, controlling who can read them, and working with them through remote MCP. It runs on Cloudflare.

**Phase 1:** this build supports publishing, editing and reading artefacts over MCP, as well as sign-in and member and bot administration. Read-host delivery is not part of this build. See [the specification](docs/spec.md).

Runtime: 3,022 lines under `src/`.

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

The first eligible verified address in `ADMIN_EMAILS` can bootstrap an administrator. This is a one-time action. Later sign-ins create pending members unless an OIDC provider grants `autoJoinRole` after its claim checks. Keep an active administrator to manage access.

## Deploy

1. Install Node.js 24+ and run `npm ci`.
2. Provision a D1 database, an R2 bucket and a KV namespace. Copy `wrangler.jsonc` to a private file and set its resource bindings (including the `BLOBS` bucket name), provider settings, custom domains and matching HTTPS origins; leave `main` and `migrations_dir` relative to this checkout.
3. Set the secrets on the target Worker (`npx wrangler secret put <NAME> --config <private path>`). Keep `ALLOW_DCR` off unless a required client demonstrably needs it.
4. Run `npm run deploy -- --config <private path>`. The script temporarily copies the private configuration into the checkout so Wrangler resolves its paths there, applies the remote D1 migrations, then deploys.
5. Open the manage origin and sign in as the bootstrap administrator.

Existing Gate 0 databases apply `0002_oauth_code_redemption.sql` to add replay tracking. It also works if the redemption table was already created manually.

## Connect an agent

- **Claude and Codex:** Use their native CIMD support with the Streamable HTTP URL `https://<manage>/mcp`, then sign in and approve the request.
- **OMP:** Use the Forge-hosted CIMD document with a loopback callback:

  ```json
  {"type":"http","url":"https://<manage>/mcp","oauth":{"clientId":"https://<manage>/oauth/clients/local.json","redirectUri":"http://127.0.0.1:3000/callback"}}
  ```

  Consent shows this generic client as an unverified local application and shows the loopback port.

- **Hermes:** Create a bot and token under **Bots and API tokens**, copy the token when shown, and send `Authorization: Bearer fgt_<token>` to the same `/mcp` URL.
- For browser-based MCP clients, add their exact HTTPS origins to the optional comma-separated `MCP_ALLOWED_ORIGINS`. Leave it unset for clients that do not send an `Origin` header.

OAuth access tokens last up to one hour and are shortened near the grant's seven-day cap. Codes are single-use: overlapping exchanges revoke the grant, and only a confirmed KV rate limit before the code is consumed permits retrying it. Access tokens without `grantId` are refused. If the grant already carries `sid`, refresh to acquire `grantId`; original Gate 0 grants without `sid` require fresh authorization.

MCP tools:

- `whoami`: check the connected identity, role and instance URLs.
- `list_artefacts`, `get_artefact`, `read_file`: find artefacts, inspect files and read revision-specific text.
- `publish`: merge or replace files with inline UTF-8 or base64. New artefacts are private.
- `edit_file`: replace literal text at an expected revision; stale edits fail without changing the artefact.
- `set_visibility`: change an artefact between private and public without creating a revision.

## License

MIT, see [LICENSE](LICENSE).
