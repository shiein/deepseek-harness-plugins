/**
 * project-command 适配器（方案 §6.1 project、§8 project 字段表）。
 * - 只运行配置中显式的 executable + args + cwd；不把自然语言拼成 shell；不从 dev 脚本名推断安全性
 * - 进程以新进程组启动并登记账本；端口以归属核对后的实际监听为准（§9.2）
 * - 默认 mock-only 不可满足（项目 dev server 代理可能转发真实后端）→ needs_configuration
 * - 可选前置代理（受控响应层）仅在样本验证可行后对该项目启用
 */

import type { Adapter } from '../types.ts'
import { planProjectCommand, projectCommandCapabilities } from './preflight.ts'
import { startProjectCommand } from './runtime.ts'

export const projectCommandAdapter: Adapter = {
  id: 'project-command',
  version: '0.0.0',
  strategies: ['project'],
  // 与旧 ID 分支一致：project 策略不接受场景、断言或 isolated-target。
  features: { scenarios: false, targetAssertions: false, isolatedTarget: false },
  async probe(ctx) {
    return { matched: Boolean(ctx.config.project.runtime.command), capabilities: projectCommandCapabilities(), evidence: ['Explicit command metadata only; no script/configuration was executed'], limits: ['Project data access and compilation are uncontrolled; an exact user-approved fingerprint is required'] }
  },
  async discover(ctx) {
    return { candidates: (ctx.config.project.targets ?? []).map(target => ({ projectId: ctx.config.project.id, selector: { kind: 'registered', id: target.id }, relation: ['Explicit project service target mapping'], evidence: 'strong' })), manualOnly: true, unresolved: ['No route-to-source or compilation/HMR graph is inferred from command names'] }
  },
  plan: planProjectCommand,
  start: startProjectCommand,
}
