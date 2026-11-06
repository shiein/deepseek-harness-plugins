/**
 * Host 插件：注册工具、订阅会话事件、管理 Runner 子进程（方案 §3.1、§4）。
 *
 * Phase 0 已实测：0.2.1-rc.5 的本地脚本模型驱动真实 loop，正常/取消/失败均关闭轮次。
 * exec.agent.session 是调用者会话，ctx.workingDirectory.get(session) 是有效工作目录。
 * 产品工具用 session.header.cwd 固定工作区归属，有效 cd 不改变既有预览的访问范围。
 * write 的 exec.arguments.file_path 保留相对输入，result.meta.path 是规范化路径。
 * 细节与边界见 docs/phase0-verification.md。
 * TODO(phase0):
 *   - 完整持久化恢复（resume）的轮次事件语义；当前只测了 seed 不重放通知
 * Host → Client 的 Remote stream 路径已由 dev/bridge 独立探针验证，产品接入留在 Phase 1。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import { RunnerClient } from './runner-client.ts'
import { SessionRegistry } from './session-registry.ts'
import { PanelService } from './panel-service.ts'
import { ImpactService } from './impact-service.ts'
import { registerTools } from './tools/index.ts'
import { TurnTracker } from './turn-tracker.ts'
import { requestExecutionApproval } from './execution-approval.ts'
import { requestConfigWriteApproval, requestSetupWriteApproval } from './setup-write-approval.ts'
import { DEFAULT_TRIGGER_MODE, TRIGGER_MODES } from './trigger.ts'
import type { TriggerMode } from './trigger.ts'

export const name = 'page-preview'
// workingDirectory：tools/result 提取写路径时取有效工作目录（R3-4）。
export const inject = ['tools', 'sessions', 'workingDirectory']

/**
 * 插件配置（cordis.patch.yml 的 page-preview 条目 config 段）。
 * trigger：turn/end 后的触发模式（R3-5，默认 smart）；非法值按配置错误抛错，不静默回退。
 */
export interface Config { dataDir?: string; nodeExecutable?: string; trigger?: TriggerMode }

/**
 * 会话沙箱是否为 danger-full-access（Full access 与 Auto 预设）。经 DSH 的 sandboxPolicy 服务按会话解析；
 * 服务缺失或解析失败时返回 false，仍走官方审批，不臆测为放行。
 */
export function sessionHasFullAccess(ctx: Context, exec: ToolRunContext): boolean {
  const session = exec.agent?.session
  if (session === undefined) return false
  try {
    // sandboxPolicy 由 dsh-sandbox-policy 注册；本插件不新增该依赖，只按其公开 resolve 形状结构化读取。
    const policy: unknown = ctx.get('sandboxPolicy')
    if (!policy || typeof policy !== 'object' || !('resolve' in policy)) return false
    if (typeof policy.resolve !== 'function') return false
    const resolved: unknown = policy.resolve({ session })
    return !!resolved && typeof resolved === 'object' && 'mode' in resolved && resolved.mode === 'danger-full-access'
  } catch { return false }
}

export function apply(ctx: Context, config: Config = {}) {
  const dataDir = config.dataDir
  if (config.trigger !== undefined && !(TRIGGER_MODES as readonly string[]).includes(config.trigger)) {
    throw new Error('Invalid page-preview trigger mode ' + JSON.stringify(config.trigger)
      + '; expected one of ' + TRIGGER_MODES.join(', '))
  }
  const runner = new RunnerClient(config)
  // R3-4：影响分析服务——open 无 target / status suggestions / turn/end 分析共用同一份轮次状态。
  const impact = new ImpactService(dataDir === undefined ? {} : { dataDir })
  const registry = new SessionRegistry(runner, undefined, {
    ...config,
    impact,
    triggerMode: config.trigger ?? DEFAULT_TRIGGER_MODE,
    ...(dataDir === undefined ? {} : { requestApproval: (caller, project, exec, previous, generated) =>
      requestExecutionApproval(ctx.get('approval'), dataDir, caller, project, exec, previous, generated) }),
    fullAccess: exec => sessionHasFullAccess(ctx, exec),
    requestSetupWrite: (caller, projectId, file, exec) =>
      requestSetupWriteApproval(ctx.get('approval'), caller, projectId, file, exec),
    requestConfigWrite: (caller, projectId, scenario, exec) =>
      requestConfigWriteApproval(ctx.get('approval'), caller, projectId, scenario, exec),
  })
  // dsh-working-directory 未列为直接依赖：经 ctx.get 取服务，get(session) 同步返回有效绝对目录；
  // 服务缺失只是失去相对写路径的归位，tools/result 提取退回 meta.path/绝对参数。
  let workingDirectory: { get(session: Session): string } | undefined
  try { workingDirectory = ctx.get('workingDirectory') } catch { workingDirectory = undefined }
  const tracker = new TurnTracker(registry, impact, exec => {
    const session = exec.agent?.session
    if (!session || workingDirectory === undefined) return undefined
    try { return workingDirectory.get(session) } catch { return undefined }
  })
  new PanelService(ctx, registry)

  registerTools(ctx, registry)

  ctx.on('session/event', (session, event) => tracker.onSessionEvent(session, event))
  ctx.on('session/disposed', session => { impact.forget(session.id); registry.disposeSession(session.id) })
  ctx.on('tools/result', (exec, result) => {
    tracker.onToolResult(exec, result)
    return undefined
  })

  ctx.effect(() => async () => {
    const result = await runner.dispose()
    if (result.residual.length) throw new Error('Page preview cleanup has unverified residual resources')
  })
}
