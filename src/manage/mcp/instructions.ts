/**
 * Returned on `initialize`, so every MCP client gets the publishing guardrails without a plugin skill.
 * Clients truncate long instructions (OMP at 4,000 characters, Claude Code at 4,096, older Claude Code at 2,048):
 * keep it under 4,000 and keep the rules first.
 */
export const MCP_INSTRUCTIONS = `Forge hosts static artefacts: each slug holds files served under a canonical URL. Canonical and share-link URLs always serve the current head, never a pinned revision.

Rules:
- Every access change needs the user's explicit approval: set_visibility, create_share_link, revoke_share_link, rename_artefact, restore_revision, delete_artefact, set_redirects. Before making a slug public or creating a share link, get approval for access to the current and all future heads while the grant stays active. Never change access to make a check pass.
- An update reaches the slug's current audience: anyone if public, members if private, and every holder of an active share link. Get the user's approval for that audience before writing.
- Tags on public artefacts appear in the public gallery. Use set_artefact_tags to edit tags without making a new file revision.
- Never post a share URL or key except to its intended recipient. Never log or share upload URLs.
- Never fall back to another Forge instance.

Workflow:
1. Call whoami: check the read and manage origins and a publisher or admin role.
2. New slug: publish with expectedRevision 0; it starts private with no share link. Existing slug: get_artefact (head, visibility, entry URL) and list_share_links (active link IDs) give the approved baseline. Coordinate with whoever manages access so it stays fixed during the update; stop if access cannot be verified or is changing.
3. Local files: use only user-approved files from an export that stays unchanged through upload. Before reading, hashing or uploading, validate an approved absolute export root and a manifest mapping each selected root-relative regular file to a unique Forge path. Check every path component without following symlinks; stop on escapes, missing or non-regular files, or any change after validation. Forge paths are relative, without empty or dot-prefixed segments, backslashes or a leading slash. For an HTML site, keep or explicitly map index.html; Forge picks the entry page from the published files.
4. Pass the baseline revision as expectedRevision on every publish and edit_file. On conflict, stop and ask; never adopt a newer head without approval. Inline small UTF-8 files as {path, content}. For large or binary files, call create_uploads with the exact byte size and lowercase SHA-256, PUT the same bytes with that Content-Length to the single-use URL without MCP credentials (skip when alreadyStored), then publish {path, uploadId} as the same member on the same slug. Mode "merge" keeps omitted files; use "replace" only for an approved complete file list, and list paths in delete only for explicit removals. For a literal text change, read_file at the baseline revision, then edit_file.
5. Right before writing to an existing slug, recheck head, visibility and active link IDs; stop if they differ from the baseline. expectedRevision does not guard audience changes.
6. Verify with get_artefact: head and entry URL match the write result; a new slug is private with no active link, and an update keeps the approved visibility and link IDs. Report a mismatch as a verification failure, not a publication. Otherwise report the canonical entry URL and revision. On an uncertain result, check get_artefact or list_revisions before retrying.`
