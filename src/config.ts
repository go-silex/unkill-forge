import { z } from 'zod'

const origin = z
  .url({ protocol: /^https$/ })
  .refine((value) => URL.parse(value)?.origin === value, 'Expected a canonical HTTPS origin')
const issuer = z.url({ protocol: /^https$/ }).refine((value) => {
  const url = URL.parse(value)
  return url !== null && !url.username && !url.password && !url.search && !url.hash
}, 'Expected an HTTPS issuer URL without credentials, query or fragment')
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
)
const parseJson = z.string().transform((value, ctx): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected valid JSON' })
    return z.NEVER
  }
})
const providerBase = {
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().trim().min(1),
  clientId: z.string().min(1),
  sessionMaxHours: z.number().positive().max(8_760).default(8),
}
const scopes = z.array(z.string().regex(/^[^\s]+$/))
const providersSchema = z
  .array(
    z.discriminatedUnion('type', [
      z.strictObject({
        ...providerBase,
        type: z.literal('github'),
        scopes: scopes.default([]),
      }),
      z.strictObject({
        ...providerBase,
        type: z.literal('oidc'),
        issuer,
        scopes: scopes.default(['email', 'profile']),
        requireClaims: z.record(z.string(), z.json()).optional(),
        hostedDomains: z.array(z.string().min(1)).min(1).optional(),
        autoJoinRole: z.enum(['viewer', 'publisher']).optional(),
        revalidateAfterMinutes: z.number().min(0).default(15),
        backchannelLogout: z.boolean().default(true),
        tokenAuthMethod: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
      }),
    ]),
  )
  .min(1)

const positiveInt = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number),
  ])
  .pipe(z.int().positive())

const vars = z
  .object({
    FORGE_NAME: z.string().trim().min(1),
    READ_ORIGIN: origin,
    MANAGE_ORIGIN: origin,
    ADMIN_EMAILS: csv
      .pipe(z.array(z.email()))
      .transform((emails) => emails.map((email) => email.toLowerCase())),
    AUTH_PROVIDERS: parseJson.pipe(providersSchema),
    MCP_ALLOWED_ORIGINS: csv.pipe(z.array(origin)).optional().default([]),
    ALLOW_DCR: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    FORGE_COOKIE_KEY: z.string().min(32),
    MAX_FILES_PER_ARTEFACT: positiveInt.default(1_000),
    MAX_FILES_PER_CALL: positiveInt.pipe(z.int().max(900)).default(500),
    MAX_INLINE_BYTES: positiveInt.default(2_097_152),
    DB: z.custom<D1Database>(
      (value) => typeof (value as D1Database | undefined)?.prepare === 'function',
      'Missing D1 binding',
    ),
    BLOBS: z.custom<R2Bucket>(
      (value) =>
        typeof (value as R2Bucket | undefined)?.get === 'function' &&
        typeof (value as R2Bucket | undefined)?.put === 'function',
      'Missing R2 binding',
    ),
    OAUTH_KV: z.custom<KVNamespace>(
      (value) => typeof (value as KVNamespace | undefined)?.get === 'function',
      'Missing KV binding',
    ),
  })
  .refine((value) => value.READ_ORIGIN !== value.MANAGE_ORIGIN, {
    path: ['MANAGE_ORIGIN'],
    message: 'Read and manage origins must differ',
  })

type ProviderVars = z.output<typeof providersSchema>[number]
export type Provider = ProviderVars & { clientSecret: string }
export type Env = Record<string, unknown> & { DB: D1Database; BLOBS: R2Bucket; OAUTH_KV: KVNamespace }
export type Config = {
  name: string
  readOrigin: string
  manageOrigin: string
  adminEmails: string[]
  providers: Provider[]
  cookieKey: string
  mcpAllowedOrigins: string[]
  allowDcr: boolean
  maxFilesPerArtefact: number
  maxFilesPerCall: number
  maxInlineBytes: number
}
export type Runtime = { config: Config; env: Env }

const cache = new WeakMap<Env, Config | null>()
const secret = z.string().min(1)

export function configuration(env: Env): Config | null {
  if (cache.has(env)) return cache.get(env) ?? null
  const parsed = vars.safeParse(env)
  let config: Config | null = null
  if (!parsed.success) {
    console.error(
      'Invalid Forge configuration',
      parsed.error.issues.map(({ path, message }) => `${path.join('.')}: ${message}`),
    )
  } else {
    const value = parsed.data
    const errors: string[] = []
    const keys = new Set<string>()
    const providers: Provider[] = []
    for (const provider of value.AUTH_PROVIDERS) {
      const key = `AUTH_${provider.id.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`
      if (keys.has(key)) errors.push(`${key}: duplicate provider id or secret name`)
      keys.add(key)
      const result = secret.safeParse(env[key])
      if (result.success) providers.push({ ...provider, clientSecret: result.data })
      else errors.push(`${key}: required non-empty provider secret`)
    }
    if (errors.length) console.error('Invalid Forge configuration', errors)
    else
      config = {
        name: value.FORGE_NAME,
        readOrigin: value.READ_ORIGIN,
        manageOrigin: value.MANAGE_ORIGIN,
        adminEmails: value.ADMIN_EMAILS,
        providers,
        cookieKey: value.FORGE_COOKIE_KEY,
        mcpAllowedOrigins: value.MCP_ALLOWED_ORIGINS,
        allowDcr: value.ALLOW_DCR,
        maxFilesPerArtefact: value.MAX_FILES_PER_ARTEFACT,
        maxFilesPerCall: value.MAX_FILES_PER_CALL,
        maxInlineBytes: value.MAX_INLINE_BYTES,
      }
  }
  cache.set(env, config)
  return config
}
