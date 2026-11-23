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
