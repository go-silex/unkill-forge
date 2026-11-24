export async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(request.headers.get('Content-Length')) > limit) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return bytes.subarray(0, length)
      if (value.byteLength > limit - length) {
        await reader.cancel()
        return null
      }
      bytes.set(value, length)
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}

export const formBodyLimit = 32 * 1024

export async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (
    request.body &&
    request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded'
  )
    return null
  const bytes = await readBoundedBody(request, formBodyLimit)
  if (bytes === null) return null
  const form = new URLSearchParams(new TextDecoder().decode(bytes))
  return new Set(form.keys()).size === form.size ? form : null
}

export function isDocumentNavigation(request: Request): boolean {
  if (request.method !== 'GET') return false
  const mode = request.headers.get('Sec-Fetch-Mode')
  const dest = request.headers.get('Sec-Fetch-Dest')
  if ((mode !== null && mode !== 'navigate') || (dest !== null && dest !== 'document')) return false
  if (mode !== null && dest !== null) return true
  return (
    request.headers
      .get('Accept')
      ?.split(',')
      .some((entry) => {
        const [type, ...parameters] = entry.trim().toLowerCase().split(';')
        return (
          type.trim() === 'text/html' && !parameters.some((param) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param))
        )
      }) ?? false
  )
}

export function readCookie(request: Request, name: string): string | null {
  const prefix = `${name}=`
  let value: string | null = null
  for (const entry of request.headers.get('Cookie')?.split(';') ?? []) {
    const part = entry.trim()
    if (!part.startsWith(prefix)) continue
    if (value !== null) return null
    value = part.slice(prefix.length)
  }
  return value
}

export function writeCookie(name: string, value: string, maxAge: number, sameSite: 'Lax' | 'None' = 'Lax') {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${sameSite}`
}
