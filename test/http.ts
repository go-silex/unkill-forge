import {
  applyD1Migrations,
  createExecutionContext,
  type D1Migration,
  env,
  reset,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { base64url } from 'jose'
import { beforeEach, expect } from 'vitest'
import type { Env } from '../src/config'
import worker from '../src/index'

export const manage = 'https://manage.forge.example'
export const read = 'https://read.forge.example'
export const issuer = 'https://idp.example'
export const clientId = 'forge-test-client'
export const oidcTestSecret = crypto.randomUUID()
export const provider = {
  id: 'team',
  type: 'oidc',
  label: 'Test team',
  issuer,
  clientId,
  autoJoinRole: 'viewer',
  requireClaims: { email_verified: true, active_member: true },
  hostedDomains: ['example.test'],
  sessionMaxHours: 1,
  revalidateAfterMinutes: 10,
}
export const admin = 'owner'
export const sessionCookie = '__Host-forge-session'
export const navigation = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' }
export const flashNavigation = { ...navigation, 'Sec-Fetch-Site': 'same-origin' }
export const api = { Accept: 'application/json' }
export const jsonHeaders = { 'content-type': 'application/json' }
const bindings = env as typeof env & { TEST_MIGRATIONS: D1Migration[]; DB: D1Database }

export type Handle = (path: string | URL, init?: RequestInit) => Promise<Response>
export function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    FORGE_NAME: 'Gate 0 Test Forge',
    READ_ORIGIN: read,
    MANAGE_ORIGIN: manage,
    ADMIN_EMAILS: `${admin}@example.test`,
    AUTH_PROVIDERS: JSON.stringify([provider]),
    AUTH_TEAM_CLIENT_SECRET: oidcTestSecret,
    MCP_ALLOWED_ORIGINS: 'https://allowed-client.example',
    ALLOW_DCR: 'false',
    FORGE_COOKIE_KEY: base64url.encode(new Uint8Array(32).fill(17)),
    FORGE_SEAL_KEY: base64url.encode(new Uint8Array(32).fill(29)),
    ...overrides,
  } as Env
}

export function runtime(overrides: Partial<Env> = {}): Handle {
  const configured = configuredEnv(overrides)
  return async (path, init) => {
    const ctx = createExecutionContext()
    const response = await worker.fetch(new Request(new URL(path, manage), init), configured, ctx)
    await waitOnExecutionContext(ctx)
    return response
  }
}

export function setupStorage() {
  beforeEach(async () => {
    await reset()
    await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS)
  })
}

export class Browser {
  private cookies = new Map<string, string>()
  constructor(private send: Handle) {}

  cookie(name: string) {
    return this.cookies.get(name)
  }

  cookieHeader() {
    return Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join('; ')
  }

  async request(path: string | URL, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    const cookies = this.cookieHeader()
    if (cookies) headers.set('cookie', cookies)
    const response = await this.send(path, { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0]
      if (!pair) continue
      const equals = pair.indexOf('=')
      const name = pair.slice(0, equals)
      const value = pair.slice(equals + 1)
      if (!value || /;\s*max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  post(path: string, values: Record<string, string>, origin = manage) {
    return this.request(path, { method: 'POST', headers: { origin }, body: new URLSearchParams(values) })
  }
}

export function location(response: Response) {
  const href = response.headers.get('location')
  if (!href) throw new Error(`Expected a redirect; got ${response.status}`)
  return new URL(href, manage)
}

export function formValue(html: string, name: string) {
  for (const input of html.matchAll(/<input\b[^>]*>/g)) {
    if (input[0].includes(`name="${name}"`)) {
      const value = /\bvalue="([^"]*)"/.exec(input[0])?.[1]
      if (value !== undefined) return value
    }
  }
  throw new Error(`Missing form input: ${name}`)
}

export async function listedId(adminBrowser: Browser, path: string, display: string) {
  const response = await adminBrowser.request(path)
  expect(response.status).toBe(200)
  const row = Array.from(
    (await response.text()).matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs),
    (match) => match[1] ?? '',
  ).find((entry) => entry.includes(display))
  if (!row) throw new Error(`No ${display} entry on ${path}`)
  return formValue(row, 'id')
}

export function mcpCall(send: Handle, token?: string, origin?: string) {
  const headers = new Headers({
    ...jsonHeaders,
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26',
  })
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (origin) headers.set('origin', origin)
  return send('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    }),
  })
}

interface WhoAmIMember {
  id: string
  name: string
  kind: string
  role: string
}
export async function whoami(send: Handle, token: string) {
  const response = await mcpCall(send, token)
  expect(response.status).toBe(200)
  const body = await response.json<{
    jsonrpc: string
    id: number
    result: {
      content: { type: string; text: string }[]
      structuredContent: { member: WhoAmIMember; readUrl: string; manageUrl: string }
    }
  }>()
  expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 })
  const result = body.result
  expect(result.content).toEqual([{ type: 'text', text: expect.any(String) }])
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
  expect(result.structuredContent).toMatchObject({
    member: { id: expect.any(String) },
    readUrl: read,
    manageUrl: manage,
  })
  return result.structuredContent.member
}
