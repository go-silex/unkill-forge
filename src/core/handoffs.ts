import { base64url } from 'jose'
import type { Config, Runtime } from '../config'
import { type BrowserSession, hashSecret, randomSecret, readSession, sessionIsFresh } from './index'

const secret = /^[A-Za-z0-9_-]{43}$/
const handoffSeconds = 60
const encoder = new TextEncoder()
const keys = new WeakMap<Config, Promise<CryptoKey>>()

function signingKey(config: Config): Promise<CryptoKey> {
  let key = keys.get(config)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(config.cookieKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
    keys.set(config, key)
  }
  return key
}

function signedMessage(config: Config, payload: string) {
  return encoder.encode(`forge:read-session:${config.readOrigin}:${payload}`)
}

export async function readBoundSession(runtime: Runtime, cookie: string | null, now: number) {
  if (!cookie || cookie.length > 101) return null
  const [id, expires, mac, extra] = cookie.split('.')
  if (extra !== undefined || !secret.test(id) || !/^\d{1,13}$/.test(expires) || !secret.test(mac)) return null
  if (Number(expires) <= now) return null
  const signature = base64url.decode(mac)
  if (base64url.encode(signature) !== mac) return null
  const { config } = runtime
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await signingKey(config),
      signature,
      signedMessage(config, `${id}.${expires}`),
    ))
  ) {
    return null
  }
  const session = await readSession(runtime.env.DB, id, now)
  const provider = session && config.providers.find(({ id }) => id === session.provider)
  if (!session || !provider) return null
  return { member: session.member, fresh: sessionIsFresh(provider, session, now) }
}

export function validHandoffState(state: string | null): state is string {
  return state !== null && secret.test(state)
}

export function handoffChallenge(browser: string, nonce: string) {
  return hashSecret(`forge:handoff:${browser}:${nonce}`)
}

export async function issueHandoff(db: D1Database, session: BrowserSession, state: string, path: string) {
  const now = Date.now()
  const code = randomSecret()
  const [codeHash, stateHash] = await Promise.all([hashSecret(code), hashSecret(state)])
  await db.batch([
    db.prepare('DELETE FROM handoffs WHERE expires_at <= ?').bind(now),
    db
      .prepare(`INSERT INTO handoffs (code_hash, session_id_hash, state_hash, return_path, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
      .bind(codeHash, session.idHash, stateHash, path, now + handoffSeconds * 1000),
  ])
  return code
}

export async function redeemHandoff(
  runtime: Runtime,
  code: string | null,
  state: string | null,
  nonce: string | null,
  browser: string | null,
) {
  if (!validHandoffState(code)) return null
  const codeHash = await hashSecret(code)
  const {
    config,
    env: { DB: db },
  } = runtime
  const now = Date.now()
  const handoff = await db
    .prepare(`DELETE FROM handoffs WHERE code_hash = ?
    RETURNING return_path AS path, session_id_hash AS sessionIdHash, state_hash AS stateHash, expires_at AS expiresAt`)
    .bind(codeHash)
    .first<{ path: string; sessionIdHash: string; stateHash: string; expiresAt: number }>()
  if (!handoff || handoff.expiresAt <= now) return null
  if (
    !validHandoffState(state) ||
    !validHandoffState(nonce) ||
    !validHandoffState(browser) ||
    (await handoffChallenge(browser, nonce)) !== state ||
    (await hashSecret(state)) !== handoff.stateHash
  ) {
    return { kind: 'retry' } as const
  }
  const session = await readSession(db, handoff.sessionIdHash, now)
  const provider = session && config.providers.find(({ id }) => id === session.provider)
  const completedAt = Date.now()
  if (!session || !provider || !sessionIsFresh(provider, session, completedAt)) return null
  const expiresAt = Math.floor(session.expiresAt)
  if (expiresAt <= completedAt) return null
  const payload = `${session.idHash}.${expiresAt}`
  const mac = await crypto.subtle.sign('HMAC', await signingKey(config), signedMessage(config, payload))
  return {
    kind: 'session' as const,
    path: handoff.path,
    cookie: `${payload}.${base64url.encode(new Uint8Array(mac))}`,
    maxAge: Math.ceil((expiresAt - completedAt) / 1000),
  }
}
