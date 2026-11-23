import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readRequestBody } from '@modelcontextprotocol/sdk/server/requestBody.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isJsonContentType } from '@modelcontextprotocol/sdk/shared/mediaType.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MAX_ARTEFACT_FILES, type Runtime } from '../../config'
import type { Member } from '../../core'

import {
  ArtefactError,
  checkPublishArrayLengths,
  editFile,
  getArtefact,
  listArtefacts,
  publish,
  readFile,
  setVisibility,
} from '../../core/artefacts'
import { checkUploadCount, createUploads } from '../../core/uploads'

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError } : { structuredContent: value }),
  }
}

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  run: (input: z.output<S>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  readOnly = false,
  checkArguments?: (args: unknown) => void,
) {
  const schema = z.toJSONSchema(input, { io: 'input' }) as Tool['inputSchema']
  const definition: Tool = {
    name,
    description,
    inputSchema: schema,
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }
  return {
    definition,
    async call(args: unknown) {
      try {
        checkArguments?.(args)
        const parsed = input.safeParse(args ?? {})
        if (!parsed.success)
          return result({ error: 'invalid_input', message: 'Arguments do not match the tool schema' }, true)
        return result(await run(parsed.data))
      } catch (error) {
        if (error instanceof ArtefactError) {
          return result({ error: error.code, message: error.message, ...error.extra }, true)
        }
        console.error('Forge MCP tool failed', name)
        throw new McpError(ErrorCode.InternalError, 'Forge is unavailable')
      }
    },
  }
}

const slug = z.string().describe('1–64 lowercase letters, digits or internal hyphens')
const path = z.string().describe('Relative POSIX file path; no hidden or empty segments')
const cursor = z.string().optional().describe('Cursor from the previous page')
const revision = z.int().positive()
const inlineFile = z.strictObject({
  path,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional().describe('Defaults to utf8'),
})
const uploadFile = z.strictObject({ path, uploadId: z.uuid() })
const uploadRequest = z.strictObject({
  path: path.max(1024),
  size: z.int().nonnegative(),
  sha256: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/),
  contentType: z
    .string()
    .max(255)
    .pipe(
      z
        .string()
        .regex(
          /^[!#$%&'*+.^_`|~\w-]+\/[!#$%&'*+.^_`|~\w-]+(?:[ \t]*;[ \t]*[!#$%&'*+.^_`|~\w-]+=(?:[!#$%&'*+.^_`|~\w-]+|"(?:[\t !#-[\]-~]|\\[\t -~])*"))*$/,
        ),
    )
    .optional(),
})

function requestError(status: number, code: ErrorCode, message: string, error: string) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message, data: { error } } }, { status })
}

// This only budgets allocations; JSON.parse still validates syntax.
// Count container openings, primitive starts, and strings that are not object keys.
function exceedsJsonBudget(text: string) {
  let depth = 0
  let values = 0
  let string = false
  let afterString = false
  let primitive = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (string) {
      if (char === '\\') i++
      else if (char === '"') {
        string = false
        afterString = true
      }
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      primitive = false
      continue
    }
    if (afterString) {
      if (char !== ':') values++
      afterString = false
    }
    if (char === '"' || char === '{' || char === '[') {
      if (char === '"') string = true
      else {
        values++
        if (++depth > 32) return true
      }
      primitive = false
    } else if (char === '}' || char === ']') {
      depth--
      primitive = false
    } else if (char === ':' || char === ',') {
      primitive = false
    } else if (!primitive) {
      values++
      primitive = true
    }
    if (values > 64_000) return true
  }
  return values + Number(afterString) > 64_000
}

export async function handleMcp(request: Request, runtime: Runtime, member: Member): Promise<Response> {
  const { config } = runtime
  let parsedBody: unknown
  const accept = request.headers.get('accept')
  // Keep the SDK's HTTP header checks ahead of body parsing.
  if (
    request.method === 'POST' &&
    accept?.includes('application/json') &&
    accept.includes('text/event-stream') &&
    isJsonContentType(request.headers.get('content-type'))
  ) {
    const maxBody = Math.ceil((config.maxInlineBytes * 4) / 3) + 512 * 1024
    try {
      const body = await readRequestBody(request, maxBody)
      if (body.tooLarge) {
        return requestError(413, ErrorCode.InvalidRequest, `MCP body exceeds ${maxBody} bytes`, 'too_large')
      }
      if (exceedsJsonBudget(body.text)) {
        return requestError(
          413,
          ErrorCode.InvalidRequest,
          'MCP body has too many JSON values or nesting levels',
          'too_large',
        )
      }
      parsedBody = JSON.parse(body.text)
    } catch {
      return requestError(400, ErrorCode.ParseError, 'Invalid JSON', 'parse_error')
    }
    if (Array.isArray(parsedBody)) {
      return requestError(
        400,
        ErrorCode.InvalidRequest,
        'MCP does not accept JSON-RPC batches',
        'invalid_request',
      )
    }
    if (isInitializeRequest(parsedBody) && parsedBody.params.protocolVersion < '2025-06-18') {
      parsedBody.params.protocolVersion = LATEST_PROTOCOL_VERSION
    }
  }

  const server = new Server({ name: config.name, version: '0.0.0' }, { capabilities: { tools: {} } })
  const tools = [
    tool(
      'whoami',
      'Show the authenticated Forge member, their current role, and the instance URLs. Does not change anything.',
      z.strictObject({}),
      () => {
        const { id, name, kind, role } = member
        return {
          member: { id, name, kind, role },
          readUrl: config.readOrigin,
          manageUrl: config.manageOrigin,
        }
      },
      true,
    ),
    tool(
      'list_artefacts',
      'Find live artefacts by slug or title without changing them. Tell the user which results match; use nextCursor for more.',
      z.strictObject({ query: z.string().max(200).optional(), cursor }),
      (input) => listArtefacts(runtime, member, input.query, input.cursor),
      true,
    ),
    tool(
      'get_artefact',
      'Inspect the current revision, visibility, files and entry URL without changing them. Tell the user the URL and visibility; keep the revision for conditional writes.',
      z.strictObject({ slug, cursor }),
      (input) => getArtefact(runtime, member, input.slug, input.cursor),
      true,
    ),
    tool(
      'read_file',
      'Read a text slice at the head or a specific revision without changing it. Use the returned revision for edits, and tell the user if only metadata was available.',
      z.strictObject({
        slug,
        path,
        revision: revision.optional(),
        offset: z.int().nonnegative().optional(),
        limit: z.int().positive().optional().describe('Defaults to 40,000 characters, capped at 100,000'),
      }),
      (input) => readFile(runtime, member, input.slug, input.path, input.revision, input.offset, input.limit),
      true,
    ),
    tool(
      'publish',
      'Create or publish a revision with inline content or stored upload IDs. New artefacts are private. Merge keeps unmentioned paths; replace drops them. Use expectedRevision to avoid overwriting a newer head. Tell the user the entry URL and revision.',
      z.strictObject({
        slug,
        title: z.string().max(200).optional(),
        files: z.array(z.union([inlineFile, uploadFile])).max(MAX_ARTEFACT_FILES),
        mode: z.enum(['merge', 'replace']),
        delete: z.array(path).max(MAX_ARTEFACT_FILES).optional(),
        expectedRevision: z.int().nonnegative().optional().describe('Use 0 to require a new slug'),
        message: z.string().max(1_000).optional(),
      }),
      (input) => publish(runtime, member, input),
      false,
      (args) => {
        if (typeof args === 'object' && args !== null) checkPublishArrayLengths(args)
      },
    ),
    tool(
      'create_uploads',
      'Prepare binary or large files for a publish. PUT each file to its single-use URL with its exact Content-Length, unless alreadyStored is true. Use the returned uploadId and path in publish. Do not share the capability URLs.',
      z.strictObject({
        slug: slug.max(64),
        files: z.array(uploadRequest).min(1).max(config.maxBlobWritesPerCall),
      }),
      (input) => createUploads(runtime, member, input),
      false,
      (args) => {
        if (typeof args === 'object' && args !== null) checkUploadCount(args, config.maxBlobWritesPerCall)
      },
    ),
    tool(
      'edit_file',
      'Replace literal text in a file and publish a new revision. Read the file first and pass its revision. Use replaceAll only when every match should change. On conflict, read again before editing. Tell the user the new revision.',
      z.strictObject({
        slug,
        path,
        oldText: z.string(),
        newText: z.string(),
        expectedRevision: revision,
        replaceAll: z.boolean().optional(),
      }),
      (input) => editFile(runtime, member, input),
    ),
    tool(
      'set_visibility',
      'Change who can read the canonical artefact URL without publishing a new revision. Public means anyone; private means members. Tell the user the resulting visibility.',
      z.strictObject({ slug, visibility: z.enum(['private', 'public']) }),
      (input) => setVisibility(runtime, member, input.slug, input.visibility),
    ),
  ]
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map((tool) => tool.definition) }))
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const entry = tools.find((tool) => tool.definition.name === params.name)
    if (!entry) return result({ error: 'invalid_input', message: 'Unknown Forge tool' }, true)
    return entry.call(params.arguments)
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request, { parsedBody })
  } finally {
    await server.close()
  }
}
