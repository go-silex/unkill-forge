import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Config } from '../../config'
import type { Member } from '../../core'

export async function handleMcp(request: Request, config: Config, member: Member): Promise<Response> {
  const server = new McpServer({ name: config.name, version: '0.0.0' })
  server.registerTool(
    'whoami',
    {
      description:
        'Show the authenticated Forge member, their current role, and the instance URLs. Does not change anything.',
      annotations: { readOnlyHint: true },
    },
    () => {
      const { id, name, kind, role } = member
      const result = {
        member: { id, name, kind, role },
        readUrl: config.readOrigin,
        manageUrl: config.manageOrigin,
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }
    },
  )
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
