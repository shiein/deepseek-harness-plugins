/** 自有 Vue CLI 执行器 IPC（方案 §6.5、§6.9、§9.2）；不使用项目 stdout，消息仅表述各自证据。 */
import { isAbsolute } from 'node:path'
import { DiagnosticCode } from '../../../shared/errors.ts'
import { z } from 'zod'
import { previewPlanSchema } from '../../../shared/plan-schema.ts'
import { scenarioConfigSchema, validateConfig } from '../../../shared/config/schema.ts'
import type { ProjectConfig } from '../../../shared/config/schema.ts'
import { isBrowserReport } from '../../../runner/response-layer/report-channel.ts'
import type { BrowserReport } from '../../../runner/response-layer/report-channel.ts'

const absolute = z.string().refine(isAbsolute)
const input = z.strictObject({
  type: z.literal('start'), previewId: z.string().min(1), workspaceRoot: absolute, appRoot: absolute,
  temporaryRoot: absolute, buildCacheRoot: absolute.exactOptional(), project: z.unknown(), plan: previewPlanSchema,
})
export type CliWorkerInput = Omit<z.infer<typeof input>, 'project'> & { project: ProjectConfig }
export function parseCliWorkerInput(raw: unknown): CliWorkerInput {
  const parsed = input.parse(raw)
  const config = validateConfig({ schemaVersion: 1, projects: [parsed.project] }).config
  const project = config?.projects[0]
  if (!project || project.id !== parsed.plan.projectId || parsed.plan.adapter.id !== 'vue-cli' || parsed.plan.strategy !== 'isolated' || parsed.plan.process.kind !== 'in-runner') throw new Error('Invalid Vue CLI worker execution binding')
  return { ...parsed, project }
}
const handlerReply = z.strictObject({ type: z.literal('handlers-verified') })
/** 只用于一次启动中紧邻 handler import 的 Root 复核；不是用户批准或批准记录。 */
export type CliHandlerReply = z.infer<typeof handlerReply>
export function parseCliHandlerReply(raw: unknown): CliHandlerReply { return handlerReply.parse(raw) }
/** Host 侧 page_preview_refresh 透传（R2-P0-2）；worker 只按 seq 唤醒等待的构建轮询。 */
const refreshInput = z.strictObject({ type: z.literal('refresh') })
export type CliRefreshInput = z.infer<typeof refreshInput>
export function isCliRefreshInput(raw: unknown): raw is CliRefreshInput { return refreshInput.safeParse(raw).success }
/** R3-2：Runner 预检后的场景更新（只含数据面；handlers 绑定变化在 Runner 已拒绝）。 */
const scenarioUpdateInput = z.strictObject({
  type: z.literal('scenario-update'), name: z.string().min(1), scenario: scenarioConfigSchema,
})
export type CliScenarioUpdate = z.infer<typeof scenarioUpdateInput>
export function isCliScenarioUpdate(raw: unknown): raw is CliScenarioUpdate {
  return scenarioUpdateInput.safeParse(raw).success
}
export function parseCliScenarioUpdate(raw: unknown): CliScenarioUpdate { return scenarioUpdateInput.parse(raw) }
const output = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('booted'), pid: z.int().positive() }),
  z.strictObject({ type: z.literal('verify-handlers'), pid: z.int().positive() }),
  z.strictObject({ type: z.literal('ready'), pid: z.int().positive(), origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), nonce: z.string().min(24) }),
  z.strictObject({ type: z.literal('report'), report: z.custom<BrowserReport>(isBrowserReport) }),
  z.strictObject({ type: z.literal('compile-error'), message: z.string().max(8192).exactOptional(), file: z.string().max(4096).exactOptional(), line: z.int().positive().exactOptional(), column: z.int().positive().exactOptional(), frame: z.string().max(8192).exactOptional() }),
  z.strictObject({ type: z.literal('compiled') }),
  // 浏览器已证明加载了最近一次成功编译（document-loaded 印章匹配），freshness 可推进 current。
  z.strictObject({ type: z.literal('applied') }),
  // page_preview_refresh 应答（R2-P0-2）：stale=true 表示上次编译失败，重载只能证明旧构建。
  z.strictObject({ type: z.literal('refresh-ack'), stale: z.boolean() }),
  // R3-2：场景更新应答；stale=入口重写后构建未成功/未观察到（已换绑），
  // applied:false=入口在期限内未生效、未换绑（R5-0b 决策①），error=worker 侧拒绝（Runner 已预检，属防御）。
  z.strictObject({ type: z.literal('scenario-ack'),
    stale: z.boolean().exactOptional(), applied: z.boolean().exactOptional(),
    error: z.string().max(4096).exactOptional() }),
  // 项目 devServer 字段被接管清单（R2-P0-1）：removed=未执行，overridden=自有值替代。
  z.strictObject({ type: z.literal('dev-server-diff'),
    fields: z.array(z.strictObject({ key: z.string().max(64), action: z.enum(['removed', 'overridden']) })).max(64) }),
  // queryKeys 只含观察到的 query 键名（无值）；R3-1 未命中汇总用。
  z.strictObject({ type: z.literal('http-diagnostic'),
    code: z.enum([DiagnosticCode.unmatchedRequest, DiagnosticCode.blockedRequest, DiagnosticCode.configInvalid,
      DiagnosticCode.unsupportedCapability, DiagnosticCode.runtimeError, DiagnosticCode.protocolViolation]),
    method: z.string().max(16).exactOptional(), origin: z.string().max(4096).exactOptional(),
    path: z.string().max(4096).exactOptional(),
    queryKeys: z.array(z.string().max(256)).max(32).exactOptional() }),
  z.strictObject({ type: z.literal('failed'), code: z.enum([DiagnosticCode.toolchainMismatch, DiagnosticCode.runtimeError, DiagnosticCode.configInvalid, DiagnosticCode.compileError]), message: z.string().max(8192).exactOptional(), stack: z.string().max(8192).exactOptional() }),
])
export type CliWorkerOutput = z.infer<typeof output>
export function parseCliWorkerOutput(raw: unknown): CliWorkerOutput { return output.parse(raw) }
/** 预览页文件名以 dev-server 根路径形式监听；webpack 产物/公共目录资源经准入判定后由 dev-server 自供。 */
export const CLI_PAGE_PATH = '/__dsh_page_preview__/index.html'
export const CLI_PAGE_NAME = 'dshPagePreview'
