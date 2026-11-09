/**
 * DSH 0.2.2 把工具执行器和审批状态拆成了独立服务；桌面版自带它们，测试的最小组合要自己接入。
 * 这里仍用官方实现，让用例继续走真实的 DSH 工具管线，并按单次调用断言。
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import type { ToolBatchInput, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'

export interface SingleToolCall {
  callId: ToolCallId
  name: string
  arguments: unknown
  signal: AbortSignal
  agent?: ToolBatchInput['agent']
}

const withExecutor = new WeakSet<object>()

export async function executeTool(tools: ToolRuntime, call: SingleToolCall) {
  if (!withExecutor.has(tools)) {
    withExecutor.add(tools)
    // Service.ctx 是 protected；执行器必须绑定到同一 Context，测试里没有别的取得方式。
    tools.setExecutor(new NativeToolExecutor((tools as unknown as { ctx: Context }).ctx))
  }
  const batch = await tools.execute({
    calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
    signal: call.signal,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
  })
  const first = batch.results[0]
  if (first === undefined) throw new Error('The tool pipeline returned no result for the call')
  return first.result
}

/** 官方审批服务及其依赖的会话投影；根 Context 上直接构造，需要显式完成初始化。 */
export async function installApproval(
  ctx: Context,
  config: { policy?: 'ask' | 'never' } = {},
): Promise<ApprovalService> {
  const projections = new SessionProjectionRegistry(ctx)
  await (projections as unknown as Record<symbol, () => Promise<void>>)[Service.init]?.()
  const approval = new ApprovalService(ctx, config as never)
  await (approval as unknown as Record<symbol, () => Promise<void>>)[Service.init]?.()
  return approval
}
