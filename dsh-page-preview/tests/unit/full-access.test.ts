/**
 * 完全访问会话的执行放行（方案 §0.3 第 8 条，2026-11-03 Aesc 决策）。
 * 使用 DSH 真实的 sandboxPolicy/sessionProjections 服务（锁定 0.2.1-rc.5 的传递依赖，仅测试导入）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { sessionHasFullAccess } from '../../src/host/plugin.ts'

test('full access is read from the real DSH sandbox policy of the calling session only', async t => {
  const ctx = new Context()
  t.after(() => { ctx.fiber.dispose() })
  const sessions = new SessionStore(ctx)
  const bare = sessions.create(SessionId('bare'), { meta: { cwd: '/tmp' } })
  // exec 只用到 agent.session；其余 ToolRunContext 字段与该判定无关，构造后收窄类型。
  const exec = (session: unknown) => ({ agent: { session } }) as unknown as ToolRunContext
  assert.equal(sessionHasFullAccess(ctx, exec(bare)), false, 'no sandbox service means the official dialog still runs')
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
  await new Promise(resolve => setTimeout(resolve, 20))
  const owner = sessions.create(SessionId('owner'), { meta: { cwd: '/tmp' } })
  const other = sessions.create(SessionId('other'), { meta: { cwd: '/tmp' } })
  assert.equal(sessionHasFullAccess(ctx, exec(owner)), false)
  setSandboxMode(owner, 'danger-full-access')
  assert.equal(sessionHasFullAccess(ctx, exec(owner)), true, 'Full access / Auto presets use danger-full-access')
  assert.equal(sessionHasFullAccess(ctx, exec(other)), false, 'another session keeps its own mode')
  setSandboxMode(owner, 'workspace-write')
  assert.equal(sessionHasFullAccess(ctx, exec(owner)), false)
  assert.equal(sessionHasFullAccess(ctx, { } as unknown as ToolRunContext), false)
})
