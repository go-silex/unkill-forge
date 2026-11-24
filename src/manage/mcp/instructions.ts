/** Returned on `initialize`, so every MCP client gets the publishing guardrails without a plugin skill. */
export const MCP_INSTRUCTIONS = `Forge hosts static artefacts: each slug holds a set of files served under a canonical URL.

Publishing workflow:
1. Call whoami first. Check the member role (publisher or admin to write) and the read and manage origins; never fall back to another Forge instance.
2. New slug: publish with expectedRevision 0; it starts private with no share link. Existing slug: call get_artefact (head revision, visibility, entry URL) and list_share_links (active link IDs). An update reaches the current audience: anyone if public, members if private, and every holder of an active share link. Get the user's approval for that audience before writing. A head newer than the user's baseline is not permission to overwrite it.
3. Send only files the user approved, at relative paths without empty, "." or ".." segments, backslashes or a leading slash. Validate the whole file list before reading or uploading content, and do not follow symlinks. For an HTML site, keep or explicitly map index.html; Forge picks the entry page from the published files.
4. Inline small UTF-8 files as {path, content}. For large or binary files, call create_uploads with the exact byte size and lowercase SHA-256, PUT the same bytes to the single-use URL without your MCP credentials (skip when alreadyStored), then publish {path, uploadId}. Mode "merge" keeps omitted files; use "replace" only for an approved complete file list, and list paths in delete only for explicit removals. For a literal text change, call read_file, then edit_file.
5. Right before writing to an existing slug, recheck its head, visibility and active link IDs; stop if they changed. expectedRevision does not guard audience changes.
6. After writing, call get_artefact: the head and entry URL must match the write result, and visibility and active links must be unchanged. Report the canonical entry URL and revision. On a conflict or an uncertain result, check get_artefact or list_revisions before retrying.

set_visibility, create_share_link, revoke_share_link, rename_artefact, restore_revision, delete_artefact and set_redirects each need the user's explicit approval; never use them to make a check pass. Never post a share URL or key except to its intended recipient.`
