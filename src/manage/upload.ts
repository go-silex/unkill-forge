import type { Runtime } from '../config'
import { receiveUpload } from '../core/uploads'

export async function manageUpload(request: Request, path: string, runtime: Runtime): Promise<Response> {
  if (request.method !== 'PUT') return new Response(null, { status: 405, headers: { Allow: 'PUT' } })
  const status = await receiveUpload(
    runtime,
    path.slice('/upload/'.length),
    request.headers.get('content-length'),
    request.body,
  )
  const body = request.body
  if (body && !body.locked && !request.bodyUsed) void body.cancel().catch(() => {})
  return new Response(null, { status })
}
