/**
 * Deterministic stand-in for `@deepseek-ai/dsh-mcp-client`, used only by the pre-install
 * integration harness through AGENT_ASSETS_MCP_CLIENT_MODULE.
 *
 * It mirrors the real bridge's relevant contract: a namespace plugin with `name`, `inject`, and an
 * async `apply(ctx, config)` that registers `mcp__<serverName>__<tool>` tools on the mounting
 * context's `tools` service. No connection, no subprocess, no network.
 */

export const name = 'mcp-client'

export const inject = ['tools']

export const Config = {
  type: 'object',
  properties: {},
}

const TOOL_SUFFIXES = ['echo', 'add']

export async function apply(ctx, config) {
  const tools = ctx?.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    throw new Error('fake mcp-client: the mounting context exposes no tools service')
  }
  const serverName = typeof config?.serverName === 'string' ? config.serverName : 'unknown'
  const disposers = TOOL_SUFFIXES.map((suffix) =>
    tools.register({
      name: `mcp__${serverName}__${suffix}`,
      description: `fake ${suffix} tool of ${serverName}`,
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object' },
        render: () => [],
      },
      async execute() {
        return {}
      },
    }),
  )
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'fake-mcp-client: tools')
  // Give the mount scheduler one microtask so status reads observe the registered tools.
  await new Promise((resolve) => setTimeout(resolve, 0))
}
