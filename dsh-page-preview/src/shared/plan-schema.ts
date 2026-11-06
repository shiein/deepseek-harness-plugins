/** IPC 执行计划的严格数据校验（方案 §6.2、§6.5）；不加载项目模块或读取环境。 */
import { z } from 'zod'
import type { PreviewPlan } from './contracts.ts'
import type { HostToRunner } from './ipc.ts'
const text = z.string().min(1)
const map = z.record(z.string(), z.string())
const route = z.strictObject({ path: text, params: map.exactOptional(), query: map.exactOptional() })
export const targetSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('registered'), id: text }), z.strictObject({ kind: z.literal('story'), id: text }),
  z.strictObject({ kind: z.literal('file'), path: text, exportName: text.exactOptional() }), z.strictObject({ kind: z.literal('url'), url: text }),
  z.strictObject({ kind: z.literal('route'), ...route.shape, layout: z.boolean().exactOptional() }),
])
const capability = z.strictObject({ status: z.enum(['supported', 'conditional', 'unsupported', 'unknown']), source: z.enum(['response-layer', 'carrier', 'adapter', 'project', 'none']), coverage: z.array(z.string()).exactOptional(), conditions: z.array(z.string()).exactOptional(), reason: z.string().exactOptional() })
const refresh = capability.extend({ mode: z.enum(['hmr', 'reload', 'rebuild', 'manual']).exactOptional() })
const diagnostic = z.strictObject({ code: text, phase: z.enum(['resolve', 'detect', 'plan', 'start', 'ready', 'update', 'scenario', 'capture', 'stop', 'config', 'ledger']), message: z.string(), hint: z.string().exactOptional(), previewId: z.string().exactOptional(), location: z.strictObject({ file: z.string().exactOptional(), line: z.int().positive().exactOptional(), request: z.string().exactOptional() }).exactOptional() })
export const previewPlanSchema = z.strictObject({
  projectId: text, targetId: text, selector: targetSelectorSchema, scope: z.enum(['page', 'component', 'shell']), strategy: z.enum(['static', 'isolated', 'project', 'attach']),
  route: route.exactOptional(), layout: z.boolean().exactOptional(),
  adapter: z.strictObject({ id: text, version: text }), toolchain: map, requirements: z.array(z.enum(['isolated-target', 'mock-only'])), scenario: text.exactOptional(), viewport: z.strictObject({ width: z.int().positive(), height: z.int().positive() }).exactOptional(),
  process: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('managed'), executable: text, args: z.array(z.string()), cwd: text, env: map.exactOptional() }), z.strictObject({ kind: z.literal('in-runner') }), z.strictObject({ kind: z.literal('attach'), origin: text })]),
  readiness: z.strictObject({ serviceDeadlineMs: z.int().min(1).max(2147483647), targetDeadlineMs: z.int().min(1).max(2147483647), assertions: z.array(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('mount-signal') }), z.strictObject({ kind: z.literal('text-present'), text }), z.strictObject({ kind: z.literal('selector-visible'), selector: text })])).exactOptional() }),
  capabilities: z.strictObject({ scopes: z.strictObject({ page: capability.exactOptional(), component: capability.exactOptional(), shell: capability.exactOptional() }), isolatedRender: capability, scenarioApply: capability, scenarioReset: capability, refresh, captureCurrentView: capability, runtimeErrors: capability, readinessAssertion: capability, network: z.array(z.strictObject({ channel: z.enum(['browser-http', 'browser-ws', 'browser-sse', 'service-worker', 'dev-server-proxy', 'build-process', 'server-process']), control: z.enum(['mock', 'block', 'observe', 'none']), location: z.enum(['response-layer', 'carrier', 'adapter', 'project', 'none']), note: z.string().exactOptional() })) }),
  fingerprints: z.strictObject({ sources: text.exactOptional(), config: text, scenario: text.exactOptional() }),
  generatedSetup: z.strictObject({ entry: text, hash: text }).exactOptional(),
  missing: z.array(diagnostic), knownDifferences: z.array(z.string()),
}) satisfies z.ZodType<PreviewPlan>
const ids = { requestId: text, previewId: text, ownerSessionId: text }
const schema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('start'), ...ids, plan: previewPlanSchema, workspaceRoot: text,
    configFile: text.exactOptional(),
    approval: z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).exactOptional() }),
  z.strictObject({ type: z.literal('status'), requestId: text, ownerSessionId: text, previewId: text.exactOptional() }),
  z.strictObject({ type: z.literal('stop'), ...ids }),
  z.strictObject({ type: z.literal('refresh'), ...ids, scenario: text.exactOptional() }),
  z.strictObject({ type: z.literal('inputs-changed'), previewId: text, ownerSessionId: text, paths: z.array(text) }),
  z.strictObject({ type: z.literal('shutdown'), requestId: text }),
])
export function parseHostMessage(raw: unknown): HostToRunner {
  const result = schema.safeParse(raw)
  if (!result.success) throw new Error('Invalid Host IPC message')
  return result.data
}
