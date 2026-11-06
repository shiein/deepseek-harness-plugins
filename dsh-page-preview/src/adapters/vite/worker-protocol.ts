/**
 * 自有 Vite 执行器 IPC（方案 §6.5、§9.2）；不使用项目 stdout，消息仅表述各自证据。
 * vue-vite 与 react-vite 的 worker 输入/输出 schema 完全一致（F9 抽取），
 * 唯一的框架差异是 parseViteWorkerInput 对 plan.adapter.id 的校验，由参数传入。
 */
import { isAbsolute } from 'node:path'
import { DiagnosticCode } from '../../shared/errors.ts'
import { z } from 'zod'
import { previewPlanSchema } from '../../shared/plan-schema.ts'
import { scenarioConfigSchema, validateConfig } from '../../shared/config/schema.ts'
import type { ProjectConfig } from '../../shared/config/schema.ts'
import { isBrowserReport } from '../../runner/response-layer/report-channel.ts'
import type { BrowserReport } from '../../runner/response-layer/report-channel.ts'

const absolute = z.string().refine(isAbsolute)
const input = z.strictObject({
  type: z.literal('start'), previewId: z.string().min(1), workspaceRoot: absolute, appRoot: absolute,
  temporaryRoot: absolute, buildCacheRoot: absolute.exactOptional(), project: z.unknown(), plan: previewPlanSchema,
})
export type ViteWorkerInput = Omit<z.infer<typeof input>, 'project'> & { project: ProjectConfig }
export function parseViteWorkerInput(raw: unknown, adapterId: string): ViteWorkerInput {
  const parsed = input.parse(raw)
  const config = validateConfig({ schemaVersion: 1, projects: [parsed.project] }).config
  const project = config?.projects[0]
  const bound = project && project.id === parsed.plan.projectId && parsed.plan.adapter.id === adapterId
    && parsed.plan.strategy === 'isolated' && parsed.plan.process.kind === 'in-runner'
  if (!bound) throw new Error('Invalid Vite worker execution binding')
  return { ...parsed, project }
}
const handlerReply = z.strictObject({ type: z.literal('handlers-verified') })
/** 只用于一次启动中紧邻 handler import 的 Root 复核；不是用户批准或批准记录。 */
export type ViteHandlerReply = z.infer<typeof handlerReply>
export function parseViteHandlerReply(raw: unknown): ViteHandlerReply { return handlerReply.parse(raw) }
/** R3-2：Runner 预检后的场景更新（只含数据面；handlers 绑定变化在 Runner 已拒绝）。 */
const scenarioUpdateInput = z.strictObject({
  type: z.literal('scenario-update'), name: z.string().min(1), scenario: scenarioConfigSchema,
})
export type ViteScenarioUpdate = z.infer<typeof scenarioUpdateInput>
export function isViteScenarioUpdate(raw: unknown): raw is ViteScenarioUpdate {
  return scenarioUpdateInput.safeParse(raw).success
}
export function parseViteScenarioUpdate(raw: unknown): ViteScenarioUpdate {
  return scenarioUpdateInput.parse(raw)
}
const output = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('booted'), pid: z.int().positive() }),
  z.strictObject({ type: z.literal('verify-handlers'), pid: z.int().positive() }),
  z.strictObject({ type: z.literal('ready'), pid: z.int().positive(),
    origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), nonce: z.string().min(24) }),
  z.strictObject({ type: z.literal('report'), report: z.custom<BrowserReport>(isBrowserReport) }),
  z.strictObject({ type: z.literal('compile-error'),
    message: z.string().max(8192).exactOptional(), file: z.string().max(4096).exactOptional(),
    line: z.int().positive().exactOptional(), column: z.int().positive().exactOptional(),
    frame: z.string().max(8192).exactOptional() }),
  z.strictObject({ type: z.literal('compiled') }),
  // 浏览器已证明加载/应用了最近一次成功编译（document-loaded 印章或 module-updated 版本匹配），freshness 可推进 current。
  z.strictObject({ type: z.literal('applied') }),
  // R3-2：场景更新应答；stale=入口重建/编译未成功（已换绑），
  // applied:false=更新未生效、未换绑（CLI 路径才有此形态，R5-0b），error=worker 侧拒绝（Runner 已预检，属防御）。
  z.strictObject({ type: z.literal('scenario-ack'),
    stale: z.boolean().exactOptional(), applied: z.boolean().exactOptional(),
    error: z.string().max(4096).exactOptional() }),
  // queryKeys 只含观察到的 query 键名（无值）；R3-1 未命中汇总用。
  z.strictObject({ type: z.literal('http-diagnostic'),
    code: z.enum([DiagnosticCode.unmatchedRequest, DiagnosticCode.blockedRequest, DiagnosticCode.configInvalid,
      DiagnosticCode.unsupportedCapability, DiagnosticCode.runtimeError, DiagnosticCode.projectMockUnavailable,
      DiagnosticCode.protocolViolation]),
    method: z.string().max(16).exactOptional(), origin: z.string().max(4096).exactOptional(),
    path: z.string().max(4096).exactOptional(),
    queryKeys: z.array(z.string().max(256)).max(32).exactOptional() }),
  z.strictObject({ type: z.literal('failed'),
    code: z.enum([DiagnosticCode.toolchainMismatch, DiagnosticCode.runtimeError,
      DiagnosticCode.configInvalid, DiagnosticCode.compileError]),
    message: z.string().max(8192).exactOptional(), stack: z.string().max(8192).exactOptional() }),
])
export type ViteWorkerOutput = z.infer<typeof output>
export function parseViteWorkerOutput(raw: unknown): ViteWorkerOutput { return output.parse(raw) }
