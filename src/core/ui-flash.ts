import { CompactEncrypt, compactDecrypt } from 'jose'
import type { Config, Runtime } from '../config'
import type { BrowserSession } from './index'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const keys = new WeakMap<Config, Promise<Uint8Array<ArrayBuffer>>>()

function flashKey(config: Config) {
  let key = keys.get(config)
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', encoder.encode(`forge:ui-flash:v1:${config.cookieKey}`))
      .then((bits) => new Uint8Array(bits))
    keys.set(config, key)
  }
  return key
}

export async function putUiFlash(
  { config, env: { DB: db } }: Runtime,
  session: BrowserSession,
  path: string,
  message: string,
  secret?: string,
) {
  const now = Date.now()
  const sealed =
    secret === undefined
      ? null
      : await new CompactEncrypt(encoder.encode(JSON.stringify([session.idHash, path, secret])))
          .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
          .encrypt(await flashKey(config))
  await db.batch([
    db
      .prepare(`DELETE FROM ui_flashes WHERE session_hash IN
      (SELECT session_hash FROM ui_flashes WHERE expires_at <= ? ORDER BY expires_at LIMIT 32)`)
      .bind(now),
    db
      .prepare(`INSERT INTO ui_flashes (session_hash, path, role, message, secret_sealed, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_hash) DO UPDATE SET path = excluded.path,
      role = excluded.role, message = excluded.message, secret_sealed = excluded.secret_sealed, expires_at = excluded.expires_at`)
      .bind(session.idHash, path, session.member.role, message, sealed, now + 120_000),
  ])
}

export async function takeUiFlash(
  { config, env: { DB: db } }: Runtime,
  session: BrowserSession,
  path: string,
) {
  if (session.member.status !== 'active') return null
  const notice = await db
    .prepare(`DELETE FROM ui_flashes
    WHERE session_hash = ?1 AND path = ?2 AND role = ?3 AND expires_at > ?4
    AND EXISTS (SELECT 1 FROM sessions s JOIN members m ON m.id = s.member_id
      WHERE s.id_hash = ?1 AND s.expires_at > ?4 AND s.revoked_at IS NULL AND s.generation = m.generation
      AND m.status = 'active' AND m.role = ?3)
    RETURNING message, secret_sealed AS sealed`)
    .bind(session.idHash, path, session.member.role, Date.now())
    .first<{ message: string; sealed: string | null }>()
  if (!notice) return null
  let secret: string | undefined
  if (notice.sealed !== null) {
    const { plaintext } = await compactDecrypt(notice.sealed, await flashKey(config), {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    const [id, destination, value]: [string, string, string] = JSON.parse(decoder.decode(plaintext))
    if (id === session.idHash && destination === path) secret = value
  }
  return { message: notice.message, secret }
}
