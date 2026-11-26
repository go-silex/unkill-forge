import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { ArtefactError } from '../../core/artefacts'

export function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(isError ? { isError } : { structuredContent: value }),
  }
}

export function tool<S extends z.ZodObject>(
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
