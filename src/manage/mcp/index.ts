import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readRequestBody } from '@modelcontextprotocol/sdk/server/requestBody.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isJsonContentType } from '@modelcontextprotocol/sdk/shared/mediaType.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { Runtime } from '../../config'
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

function requestError(status: number, code: ErrorCode, message: string, error: string) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message, data: { error } } }, { status })
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
    // Allow worst-case JSON string escaping (which also covers base64 expansion),
    // both path arrays, and envelope metadata, without exceeding the Worker memory budget.
    const maxBody = Math.min(
      32 * 1024 * 1024,
      65_536 + config.maxInlineBytes * 6 + config.maxFilesPerCall * 12_544,
    )
    try {
      const body = await readRequestBody(request, maxBody)
      if (body.tooLarge) {
        return requestError(413, ErrorCode.InvalidRequest, `MCP body exceeds ${maxBody} bytes`, 'too_large')
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
      'Create or publish a revision with inline files. New artefacts are private. Merge keeps unmentioned paths; replace drops them. Use expectedRevision to avoid overwriting a newer head. Tell the user the entry URL and revision.',
      z.strictObject({
        slug,
        title: z.string().max(200).optional(),
        files: z.array(inlineFile).max(config.maxFilesPerCall),
        mode: z.enum(['merge', 'replace']),
        delete: z.array(path).max(config.maxFilesPerCall).optional(),
        expectedRevision: z.int().nonnegative().optional().describe('Use 0 to require a new slug'),
        message: z.string().max(1_000).optional(),
      }),
      (input) => publish(runtime, member, input),
      false,
      (args) => {
        if (typeof args === 'object' && args !== null) checkPublishArrayLengths(args, config.maxFilesPerCall)
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
