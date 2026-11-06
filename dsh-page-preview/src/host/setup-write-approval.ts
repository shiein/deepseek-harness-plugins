/**
 * writeSetupTo 与场景写回的可信用户确认（方案 §6.9、§7.2/R5-1a）：写项目文件或仓库配置属于修改
 * 工作区内容，只能由官方 DSH 审批弹窗中的用户确认授权，Agent 自述「用户已同意」不算。每次写入单独询问，不复用。
 */
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PreviewCaller } from './caller.ts'

export type SetupWriteOutcome = 'approved' | 'rejected' | 'cancelled' | 'unavailable'

export async function requestSetupWriteApproval(
  service: Pick<ApprovalService, 'request'> | undefined,
  caller: PreviewCaller,
  projectId: string,
  file: string,
  exec: ToolRunContext,
): Promise<SetupWriteOutcome> {
  return request(service, caller, exec, {
    reason: 'Write a generated preview setup draft into project ' + projectId + ' at ' + file,
    en: 'Allow writing a generated setup draft into the project?\nProject: ' + projectId + '\nNew file: ' + file
      + '\nThe file is created only if it does not exist yet; nothing is executed until you approve '
      + 'the execution fingerprint separately.',
    zh: '是否允许把生成的 setup 草稿写入项目？\n项目：' + projectId + '\n新文件：' + file
      + '\n仅在该文件尚不存在时创建；它不会被执行，执行前仍需单独批准执行指纹。',
  })
}

/** 场景写回：Agent 提交填好的场景定义，写入工作区根 page-preview.config.json（写前备份可回滚）。 */
export async function requestConfigWriteApproval(
  service: Pick<ApprovalService, 'request'> | undefined,
  caller: PreviewCaller,
  projectId: string,
  scenario: string,
  exec: ToolRunContext,
): Promise<SetupWriteOutcome> {
  return request(service, caller, exec, {
    reason: 'Write scenario ' + JSON.stringify(scenario) + ' for project ' + projectId
      + ' into page-preview.config.json',
    en: 'Allow writing a filled fixture scenario into the workspace config?\nProject: ' + projectId
      + '\nScenario: ' + scenario
      + '\nFile: page-preview.config.json (the existing file is backed up before writing)',
    zh: '是否允许把填好的 fixture 场景写入工作区配置？\n项目：' + projectId + '\n场景：' + scenario
      + '\n文件：page-preview.config.json（已有文件写前备份）',
  })
}

async function request(
  service: Pick<ApprovalService, 'request'> | undefined,
  caller: PreviewCaller,
  exec: ToolRunContext,
  text: { reason: string; en: string; zh: string },
): Promise<SetupWriteOutcome> {
  if (!service || !exec.agent || exec.agent.session.id !== caller.ownerSessionId) return 'unavailable'
  if (exec.signal.aborted) return 'cancelled'
  const outcome = await service.request({
    agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
    reason: text.reason,
    displayReason: { en: text.en, zh: text.zh },
  })
  if (outcome !== 'allowed-once') return outcome
  return exec.signal.aborted ? 'cancelled' : 'approved'
}
