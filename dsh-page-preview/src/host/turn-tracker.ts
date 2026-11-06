/**
 * 轮次与变更来源跟踪（方案 §5.3、§9.1）。
 *
 * 已在 @deepseek-ai/dsh-session@0.2.1-rc.5 类型中确认：SessionEventMap 含
 * 'turn/start' { turn } 与 'turn/end' { turn, reason }；事件结构为 { type, seq, time, data }；
 * seed/恢复事件不发布到 session/event（firstLiveSeq 注释：seed events never publish），
 * 因此此处理的都是 live 追加，重放历史不会重建基线或重复触发。
 * 正常/取消/失败已用真实 loop + 本地脚本模型验证，见 docs/phase0-verification.md。
 * 持久化恢复（R5-9 结论）：seed/恢复事件按 firstLiveSeq 不发布到 session/event，恢复后的
 * 历史 turn 不会重放通知——tracker 只见 live turn，无双基线/重复触发；插件内存态在下一个
 * turn/start 重建。真实持久化 resume 运行的端到端证据列入实机清单。
 *
 * R3-4 接线：
 *   - turn/start → ImpactService.beginTurn（建立元数据基线）
 *   - tools/result → core/change/agent-writes.ts 提取路径 → recordAgentWrites
 *   - turn/end → ImpactService.analyzeNow → registry.onTurnAnalyzed（异步，不阻塞事件分发；失败只记诊断）
 *   - session/disposed → ImpactService.forget
 */

import { isAbsolute } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { SessionRegistry } from './session-registry.ts'
import type { ImpactService } from './impact-service.ts'
import { extractWrittenPaths } from '../core/change/agent-writes.ts'

export class TurnTracker {
  private readonly registry: SessionRegistry
  private readonly impact: ImpactService
  /** exec → 调用时的有效工作目录（plugin 注入 ctx.workingDirectory.get）。 */
  private readonly workingDirectoryOf: (exec: Readonly<ToolExecution>) => string | undefined

  constructor(registry: SessionRegistry, impact: ImpactService,
    workingDirectoryOf: (exec: Readonly<ToolExecution>) => string | undefined) {
    this.registry = registry
    this.impact = impact
    this.workingDirectoryOf = workingDirectoryOf
  }

  onSessionEvent(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start': {
        const cwd = session.header.cwd
        // 无工作区会话（cwd 缺省/非字符串/相对）不建基线；open/status 路径如实 degraded。
        if (typeof cwd !== 'string' || !isAbsolute(cwd)) break
        void this.impact.beginTurn(session.id, cwd)
        break
      }
      case 'turn/end':
        void this.impact.analyzeNow(session.id)
          .then(impact => this.registry.onTurnAnalyzed(session.id, impact))
          .catch(() => undefined) // 分析失败不冒泡到事件分发；analyzeNow 内部已如实 degraded。
        break
      default:
        break
    }
  }

  onToolResult(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void {
    const session = exec.agent?.session
    const cwd = session === undefined ? undefined : this.workingDirectoryOf(exec)
    if (!session?.id || typeof session.header.cwd !== 'string'
      || cwd === undefined || !isAbsolute(cwd)) return
    void extractWrittenPaths({
      toolName: exec.name, args: exec.arguments, meta: result.meta, ok: !result.isError, cwd,
    }, session.header.cwd)
      .then(paths => this.impact.recordAgentWrites(session.id, paths))
      .catch(() => undefined) // 提取失败只是少一条 agent-confirmed 证据，不影响 diff 本身。
  }
}
