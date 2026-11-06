/** Host↔Client 预览面板协议（方案 §4.3、§10）：zod schema 同时提供 TS 类型和两端严格编解码。 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteCodecSpec, TypertRemoteSpec } from '@deepseek-ai/dsh-typert-protocol'

/** 面板只回传同一调用者经 status/stop 即可看到的字段；诊断信息带 code/phase，不回传命令、参数或环境值。 */
export const panelDiagnosticSchema = z.strictObject({
  code: z.string().min(1).max(64),
  phase: z.string().min(1).max(32),
  message: z.string().min(1).max(2048),
  hint: z.string().max(2048).exactOptional(),
  previewId: z.string().min(1).max(128).exactOptional(),
  location: z.strictObject({
    file: z.string().min(1).max(1024).exactOptional(),
    line: z.int().positive().max(1000000).exactOptional(),
    request: z.string().min(1).max(2048).exactOptional(),
  }).exactOptional(),
})
export const evidenceSchema = z.strictObject({
  status: z.enum(['proven', 'failed', 'unverified']),
  detail: z.string().max(1024).exactOptional(),
  at: z.string().max(64).exactOptional(),
})
export const panelPreviewSchema = z.strictObject({
  previewId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(512),
  targetId: z.string().min(1).max(512),
  scope: z.string().min(1).max(32),
  strategy: z.string().min(1).max(32),
  state: z.string().min(1).max(32),
  freshness: z.string().min(1).max(32),
  url: z.url().exactOptional(),
  scenario: z.string().min(1).max(512).exactOptional(),
  capabilityGaps: z.array(z.strictObject({
    name: z.string().min(1).max(64),
    status: z.string().min(1).max(32),
    reason: z.string().max(1024).exactOptional(),
  })).max(32),
  readiness: z.strictObject({ serviceReachable: evidenceSchema, documentLoaded: evidenceSchema, targetMounted: evidenceSchema }),
  /** R3-6：该预览的未命中业务请求计数与丢弃数（与 status summarize 同口径）。 */
  unmatchedCount: z.int().min(0).exactOptional(),
  unmatchedDropped: z.int().min(0).exactOptional(),
})
/** 本轮影响分析建议（R3-6）：selector 已由 Host 投影为摘要文本；面板只展示，不执行打开。 */
export const panelSuggestionSchema = z.strictObject({
  projectId: z.string().min(1).max(512),
  selector: z.string().min(1).max(512),
  relation: z.array(z.string().min(1).max(512)).max(12),
  evidence: z.enum(['strong', 'medium', 'weak']),
  origin: z.string().min(1).max(32).exactOptional(),
  /** R5-6：一键打开的调用载荷（projectId + JSON 编码的真实 TargetSelector）；
   *  Host 侧经 openRequestSchema 严格校验后与工具 open 走同一路径（含指纹审批）。 */
  open: z.strictObject({
    projectId: z.string().min(1).max(512),
    target: z.string().min(1).max(2048),
  }).exactOptional(),
})
export const panelSnapshotSchema = z.strictObject({
  previews: z.array(panelPreviewSchema).max(64),
  diagnostics: z.array(panelDiagnosticSchema).max(32),
  diagnosticsTruncated: z.int().min(0).exactOptional(),
  /** 与 status suggestions 同一份 ImpactService.latest 投影；未分析过则字段缺失。 */
  suggestions: z.array(panelSuggestionSchema).max(3).exactOptional(),
  suggestionsOmitted: z.int().min(0).exactOptional(),
})
export const panelStopSchema = z.strictObject({
  status: z.enum(['ok', 'error', 'not_found', 'busy']),
  previewId: z.string().min(1).max(128),
  state: z.string().min(1).max(32).exactOptional(),
  residual: z.array(z.string().max(1024)).max(32).exactOptional(),
  diagnostics: z.array(panelDiagnosticSchema).max(16),
})
/** R5-6：面板一键打开的回复；诊断与 status 同口径（面板不回传命令、参数或环境值）。 */
export const panelOpenReplySchema = z.strictObject({
  status: z.enum(['ok', 'error', 'not_found', 'busy', 'needs_configuration', 'needs_selection', 'unsupported']),
  previewId: z.string().min(1).max(128).exactOptional(),
  state: z.string().min(1).max(32).exactOptional(),
  url: z.url().exactOptional(),
  diagnostics: z.array(panelDiagnosticSchema).max(16),
})
export type PanelDiagnostic = z.infer<typeof panelDiagnosticSchema>
export type PanelPreview = z.infer<typeof panelPreviewSchema>
export type PanelSuggestion = z.infer<typeof panelSuggestionSchema>
export type PanelSuggestionOpen = NonNullable<PanelSuggestion['open']>
export type PanelSnapshot = z.infer<typeof panelSnapshotSchema>
export type PanelStopReply = z.infer<typeof panelStopSchema>
export type PanelOpenReply = z.infer<typeof panelOpenReplySchema>

function codec(schema: z.ZodType, name: string): TypertRemoteCodecSpec {
  return { mode: 'strict', typeSymbol: name, create: () => schema, jsonSchema: z.toJSONSchema(schema) }
}
const sessionCodec = codec(z.string().min(1).max(256), 'PanelSessionId')
const sessionParameter = { name: 'sessionId', source: 'json', codec: sessionCodec, strictCodec: sessionCodec } as const
const previewIdCodec = codec(z.string().min(1).max(128), 'PanelPreviewId')
const openRequestCodec = codec(z.strictObject({
  projectId: z.string().min(1).max(512), target: z.string().min(1).max(2048),
}), 'PanelOpenRequest')
const spec = {
  package: 'dsh-page-preview',
  methods: {
    'pagePreview/follow': {
      service: 'pagePreview', invocation: { kind: 'direct' }, mode: 'stream',
      parameters: [sessionParameter], cancellation: { parameter: 'signal' },
      result: codec(panelSnapshotSchema, 'PanelSnapshot'),
    },
    'pagePreview/stop': {
      service: 'pagePreview', invocation: { kind: 'direct' },
      parameters: [sessionParameter, { name: 'previewId', source: 'json', codec: previewIdCodec, strictCodec: previewIdCodec }],
      result: codec(panelStopSchema, 'PanelStopReply'),
    },
    'pagePreview/open': {
      service: 'pagePreview', invocation: { kind: 'direct' },
      parameters: [sessionParameter,
        { name: 'request', source: 'json', codec: openRequestCodec, strictCodec: openRequestCodec }],
      // R5-F5：审批等待可能很长，面板侧关闭/取消经 transport 注入的 signal 终止 open。
      cancellation: { parameter: 'signal' },
      result: codec(panelOpenReplySchema, 'PanelOpenReply'),
    },
  },
} satisfies TypertRemoteSpec

const remoteInfo = createTypertRemoteInfo(spec, z)
export default remoteInfo

/** SDK Loader 支持显式 wire schema；这不是伪造的编译器反射结果。 */
export const TYPERT = {
  package: spec.package, face: 'host', schemas: [],
  get invocations() { return remoteInfo.descriptors },
  model: { services: [], events: [], objects: [] },
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    pagePreview: {
      // Client 不能导入 Host Context 的类型增强；两端 sessions 服务并非同一接口。
      follow(sessionId: string, signal: AbortSignal): RemoteStreamHandle<PanelSnapshot, never>
      stop(sessionId: string, previewId: string): Promise<RemoteResult<PanelStopReply>>
      open(sessionId: string, request: PanelSuggestionOpen): Promise<RemoteResult<PanelOpenReply>>
    }
  }
}
