/**
 * existing-server 适配器（attach，方案 §6.1、§7.4、§8）。
 * - 不拥有进程：stop 只脱离；不改写其响应；不清空用户 Cookie/Storage/服务缓存
 * - 只接入已配置、已授权的 loopback 来源；缺少目标证据时停留在 reachable
 * - mock-only 不可满足；只能在显式观察模式（空 requirements）下使用，并记录真实数据访问范围
 */

import type { Adapter } from '../types.ts'
import { existingServerCapabilities, planExistingServer } from './preflight.ts'
import { startExistingServer } from './runtime.ts'

export const existingServerAdapter: Adapter = {
  id: 'existing-server',
  version: '0.0.0',
  strategies: ['attach'],
  // 与旧 ID 分支一致：attach 路径不接受场景、断言或 isolated-target。
  features: { scenarios: false, targetAssertions: false, isolatedTarget: false },
  async probe(ctx) {
    return { matched: Boolean(ctx.config.project.runtime.origin) && !ctx.config.project.runtime.command, capabilities: existingServerCapabilities(), evidence: ['Explicit configured origin only; no network request during preflight'], limits: ['Observation only; original state, network and responses are uncontrolled'] }
  },
  async discover(ctx) {
    return { candidates: (ctx.config.project.targets ?? []).map(target => ({ projectId: ctx.config.project.id, selector: { kind: 'registered', id: target.id }, relation: ['Explicit target mapping on an existing service'], evidence: 'strong' })), manualOnly: true, unresolved: ['No source-to-route map, live DOM or runtime dependency graph is inferred'] }
  },
  plan: planExistingServer,
  start: startExistingServer,
}
