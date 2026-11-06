/** Phase 0 Client 探针（方案 §4.3、§14）：消费官方 Remote 流，只操作本探针打开的 Browser tab。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import remoteInfo from './protocol.ts'

export const inject = ['remote', 'sidebarRight', 'uiWorkspace']

export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(remoteInfo)
  await ctx.inject(['remote.pagePreviewPhase0', 'sessions'], async (scope) => {
    // Remote 可调用不代表会话目录已同步；retain 未知会话会直接抛错。
    await scope.sessions.refresh()
    scope.effect(() => install(scope))
    // 宿主会隐藏未选中的 blank 会话，标题不会改变 blank；显式打开固定测试会话。
    // 这是插件自己定义的已知 SessionId，只在这个开发探针中做品牌标记。
    scope.uiWorkspace.openSession('page-preview-phase0-carrier' as SessionId)
  })
}

function install(ctx: Context): () => void {
  let stop = () => {}
  const select = () => {
    stop()
    const sessionId = ctx.sidebarRight.mounted.getSnapshot()
    if (sessionId !== 'page-preview-phase0-carrier') return
    const control = new AbortController()
    const stream = ctx.remote.pagePreviewPhase0.follow(sessionId, control.signal)
    stop = () => { control.abort(); stream.dispose() }
    void (async () => {
      let ownedTab: TabId | undefined
      for await (const command of stream) {
        if (control.signal.aborted || ctx.sidebarRight.mounted.getSnapshot() !== sessionId) return
        let status: 'accepted' | 'error' = 'accepted'
        let detail = 'carrier API invoked; target readiness unverified'
        try {
          if (command.kind === 'open') {
            ctx.sidebarRight.openTab('browser', { params: { url: command.url } })
            const tab = ctx.sidebarRight.active()
            if (!tab || tab.kind !== 'browser') throw new Error('Browser tab was not opened')
            ownedTab = tab.id
          } else {
            const target = ctx.sidebarRight.commandTarget(null)
            if (!ownedTab || !target || target.tabId !== ownedTab || !ctx.sidebarRight.isTargetCurrent(target)) throw new Error('Owned Browser tab is not active')
            if (command.kind === 'refresh') {
              const refresh = target.occurrence?.commands.refresh
              if (!refresh) throw new Error('Browser refresh is unavailable')
              refresh()
            } else {
              ctx.sidebarRight.close(ownedTab)
              if (ctx.sidebarRight.active()?.id === ownedTab) throw new Error('Browser tab was not closed')
              ownedTab = undefined
            }
          }
        } catch (error) {
          status = 'error'
          detail = String(error)
        }
        const result = await ctx.remote.pagePreviewPhase0.acknowledge(sessionId, { id: command.id, status, detail })
        if (!result.ok) throw new Error('Carrier acknowledgement failed: ' + result.error.message)
      }
    })().catch((error: unknown) => {
      if (!control.signal.aborted) ctx.logger.error('Phase 0 carrier stream failed: ' + String(error))
    })
  }
  const unsubscribe = ctx.sidebarRight.mounted.subscribe(select)
  select()
  return () => { unsubscribe(); stop() }
}
