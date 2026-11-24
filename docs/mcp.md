# Connect and publish with MCP

Use the manage host's `https://manage.forge.example.com/mcp` (replace the example origin). Forge uses stateless MCP Streamable HTTP with JSON responses. Start with `whoami` to check the member and role. No local plugin is required.

## Choose a credential

- **OAuth for people:** the client discovers authorization from `/mcp`. Sign in and approve the client identity and redirect on the manage host. Forge requires PKCE S256 and supports Client ID Metadata Documents (CIMD); leave Dynamic Client Registration (`ALLOW_DCR`) off unless a required client demonstrably needs it. Access lasts up to one hour per token and refreshes within a seven-day absolute grant. After the cap or revocation, reauthorize. See [OAuth limits](security.md#identity-and-oauth).
- **API token for automation:** an admin creates a separate publisher bot in **Bots and API tokens** and issues a token. Copy it once into the client's secret store. Send `Authorization: Bearer fgt_…` on every MCP request. Revoke lost tokens from the manage UI. Use a bot token rather than sharing a person's token or giving automation admin access.
- **Personal API token:** publishers and admins can create and revoke their own tokens under **API tokens**. Forge displays each token only once; a viewer downgrade disables its use and management. Prefer a dedicated bot for unattended work.

The manage host's **Connect an agent** page (`/connect`) shows the URL and client options for your instance.

| Client                                  | Connection                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude (web and Desktop)                | Follow [Claude's remote connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). Individuals start in **Customize → Connectors**; on Team or Enterprise an organization admin first adds the connector under **Organization settings → Connectors → Add → Custom → Web**. Choose **Use Claude's published identity** (CIMD) and approve OAuth. Desktop uses the same remote connector, not a local `stdio` entry. |
| Claude Code                             | Run `claude mcp add --transport http forge https://manage.forge.example.com/mcp`, then use `/mcp` to authenticate.                                                                                                                                                                                                                                                                                                                                                                     |
| Codex                                   | Run `codex mcp add forge --url https://manage.forge.example.com/mcp`. See the OAuth note below.                                                                                                                                                                                                                                                                                                                                                                                        |
| OMP                                     | Use a Streamable HTTP entry with the Forge-hosted local CIMD and a loopback callback (example below).                                                                                                                                                                                                                                                                                                                                                                                  |
| Hermes, CI or another autonomous client | Configure Streamable HTTP to the same `/mcp` URL with the bot's bearer token, read from a secret store or environment at runtime.                                                                                                                                                                                                                                                                                                                                                      |

**Codex OAuth:** `codex mcp add` may start login itself; complete it in your browser. Run `codex mcp login forge` only if login did not complete.

For a browser client that sends `Origin`, add just that client's exact HTTPS origin to the comma-separated `MCP_ALLOWED_ORIGINS`; do not add the artefact (read) origin. Native clients generally do not need this setting. Follow client-side approval and organization policies as well as Forge's role checks.

OMP example:

```json
{
  "type": "http",
  "url": "https://manage.forge.example.com/mcp",
  "oauth": {
    "clientId": "https://manage.forge.example.com/oauth/clients/local.json",
    "redirectUri": "http://127.0.0.1:3000/callback"
  }
}
```

After saving the OMP entry, run `/mcp reload` and `/mcp reauth forge` (replace `forge` with your configured entry name). Forge labels that generic CIMD as an unverified local application and displays the loopback port; verify it is the port your client opened.

## Tools

`?` marks optional inputs. `tools/list` has the live schemas. Active viewers can use the read tools; writes and share management require publisher or admin. Publishers can change any artefact. Only an admin can add aliases or supply a share key.

On `initialize`, the server also returns `instructions`: the publishing workflow condensed for agents (check `whoami`, get approval for the current audience, validate file paths, recheck before writing, verify after writing, and ask before any access change). Clients that support MCP server instructions give them to the agent, so no plugin skill is needed.

| Tool                | Inputs                                                                          | Use                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`            | None                                                                            | Check member, role and origins.                                                                                                                                                                             |
| `list_artefacts`    | `query?`, `cursor?`                                                             | Find live artefacts by slug/title.                                                                                                                                                                          |
| `get_artefact`      | `slug`, `cursor?`                                                               | Get the head revision, visibility, entry URL and file metadata.                                                                                                                                             |
| `read_file`         | `slug`, `path`, `revision?`, `offset?`, `limit?`                                | Read a text slice (default 40,000 code points, max 100,000); binary or oversized files return metadata.                                                                                                     |
| `publish`           | `slug`, `files[]`, `mode`, `delete?`, `expectedRevision?`, `title?`, `message?` | Create a revision. `merge` keeps omitted files; `replace` makes the submitted list complete. Files take `{path, content, encoding?}` (`utf8` or `base64`) or `{path, uploadId}`. New artefacts are private. |
| `edit_file`         | `slug`, `path`, `oldText`, `newText`, `expectedRevision`, `replaceAll?`         | Replace literal text and create a revision. Requires exactly one match unless replacing all matches.                                                                                                        |
| `create_uploads`    | `slug`, `files[]` of `{path, size, sha256, contentType?}`                       | Allocate upload IDs and single-use PUT URLs; see below.                                                                                                                                                     |
| `set_visibility`    | `slug`, `visibility` (`private` or `public`)                                    | Change canonical access without making a revision.                                                                                                                                                          |
| `create_share_link` | `slug`, `label?`, `key?`                                                        | Create and return a bearer URL; custom keys are admin-only.                                                                                                                                                 |
| `list_share_links`  | `slug`                                                                          | List active links' IDs, labels and timestamps (no URL or key).                                                                                                                                              |
| `get_share_link`    | `id`                                                                            | Reveal an active link's full URL.                                                                                                                                                                           |
| `revoke_share_link` | `id`                                                                            | Disable the bearer URL even when the artefact is public.                                                                                                                                                    |
| `list_revisions`    | `slug`, `cursor?`                                                               | List retained history, newest first.                                                                                                                                                                        |
| `restore_revision`  | `slug`, `revision`                                                              | Create a new revision with the retained revision's files.                                                                                                                                                   |
| `rename_artefact`   | `slug`, `newSlug`                                                               | Move to an available slug and redirect old canonical and share roots.                                                                                                                                       |
| `delete_artefact`   | `slug`                                                                          | Soft-delete immediately. Admin restoration is available before 30 days elapse and only before purge starts.                                                                                                 |
| `set_redirects`     | `add[]` of `{fromPrefix, toPrefix}`, `remove[]` of source prefixes              | Admin-only; manage slash-terminated aliases to live artefacts in the same namespace. Share paths contain only `/s/<slug>/`, never keys.                                                                     |

Pass back `nextCursor` to fetch another page. Restart file listing if the head changes. Use the revision from `read_file` or `get_artefact` as `expectedRevision` for conditional writes (`0` for a new slug). On `conflict`, read the current revision before resolving the edit. Other stable errors include `not_found`, `forbidden`, `invalid_input` and `too_large`.

In Codex, make the first publish in an interactive session so you can approve the tool call. For unattended `codex exec` runs, configure an explicit per-server [`default_tools_approval_mode`](https://learn.chatgpt.com/docs/config-file/config-reference) under `[mcp_servers.forge]`.

For a first publish, call `publish` with:

```json
{
  "slug": "hello",
  "files": [{ "path": "index.html", "content": "<!doctype html><h1>Hello Forge</h1>" }],
  "mode": "replace",
  "expectedRevision": 0
}
```

Open the returned URL in your browser. It is private until a publisher changes visibility; a valid share link is a separate access path.

## Upload binary or large files

1. Compute byte count and lowercase SHA-256 from the file you will upload:

   ```sh
   wc -c < clip.mp4
   sha256sum clip.mp4  # macOS: shasum -a 256 clip.mp4
   ```

   Call `create_uploads` with `slug: "hello"` and `files: [{path: "clip.mp4", size, sha256, contentType: "video/mp4"}]`, substituting the numeric byte count and the 64-digit digest. The per-file limit is `MAX_UPLOAD_BYTES`, at most 100,000,000 bytes.

2. Within 15 minutes, assign `upload_url` from `files[0].url` in the result and PUT the same local file (skip this step if `files[0].alreadyStored` is `true`). A named file lets cURL send the declared `Content-Length`; the PUT has one hour to finish once claimed.

   ```sh
   read -r -s upload_url  # Paste files[0].url and press Enter (Bash)
   curl --fail-with-body -T clip.mp4 -H 'Content-Type: application/octet-stream' "$upload_url"
   unset upload_url
   ```

   A successful PUT returns `204`. Do not attach your MCP token; the URL itself authorizes one attempt. If the attempt failed or was interrupted, request a new slot. Do not log or share upload URLs.

3. Within one hour of storage (or an `alreadyStored` receipt), use the **same member and slug** to call `publish` with `mode: "merge"` and `files: [{path: "clip.mp4", uploadId}]`. Pass the current `expectedRevision`. A failed publish does not consume the ID; a successful one does. The published file supports single byte range requests on the read host.
