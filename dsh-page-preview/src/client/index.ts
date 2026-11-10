/**
 * Client Module（方案 §4.3、§10）。可选 GUI 能力。
 *
 * Phase 0：dev/bridge 已在锁定 SDK 上验证 Remote stream → Client 开页/刷新/关闭；
 * 动态 $mount 后须用 ctx.inject 声明 remote 命名空间。见 docs/phase0-verification.md。
 * P1-10：注册 page-preview 页型，body 消费 Host PanelService 的同会话快照流；
 * 面板只展示 status/stop 本就可见的投影，停止走同一 owner 路径，不建第二份事实源。
 * 2026-11-03：屏幕上会话的新预览自动在 Browser 页签打开（auto-open.ts）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-browser/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import remoteInfo from './protocol.ts'
import { PreviewPanel } from './panel.ts'
import { createPanelController } from './view-model.ts'
import { startAutoOpen } from './auto-open.ts'

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'remote']

const namespace = 'pagePreview'
const dictionaries: Record<string, Record<string, string>> = {
  zh: {
    title: '页面预览',
    'guide.title': '页面预览',
    'guide.description': '查看当前会话的预览状态、地址与诊断，或停止预览',
    loading: '正在连接预览状态…',
    empty: '当前会话没有预览',
    stop: '停止',
    openInBrowser: '在 Browser 中打开',
    openSuggestion: '打开预览',
    diagnostics: '诊断',
    suggestions: '本轮建议',
    suggestionsOmitted: '条候选未显示',
    unmatched: '未命中请求',
    unmatchedHint: 'fixture 草稿可经 page_preview_status detail 获取',
    copyUrl: '复制地址',
    copied: '已复制',
    dismiss: '关闭',
    working: '处理中…',
    'state.preparing': '准备中',
    'state.starting': '启动中',
    'state.reachable': '服务已响应',
    'state.ready': '就绪',
    'state.degraded': '部分可用',
    'state.updating': '更新中',
    'state.failed': '失败',
    'state.stopping': '停止中',
    'state.stopped': '已停止',
    'state.cleanup_failed': '清理未完成',
    'freshness.current': '已是最新',
    'freshness.stale': '未同步最新改动',
    'freshness.unverified': '新鲜度未确认',
  },
  en: {
    title: 'Page Preview',
    'guide.title': 'Page Preview',
    'guide.description': 'Show preview state, URL and diagnostics for this session, or stop a preview',
    loading: 'Connecting preview state…',
    empty: 'No previews in this session',
    stop: 'Stop',
    openInBrowser: 'Open in Browser',
    openSuggestion: 'Open preview',
    diagnostics: 'Diagnostics',
    suggestions: 'Suggestions',
    suggestionsOmitted: 'more candidates not shown',
    unmatched: 'Unmatched requests',
    unmatchedHint: 'fixture drafts are available via page_preview_status detail',
    copyUrl: 'Copy URL',
    copied: 'Copied',
    dismiss: 'Dismiss',
    working: 'Working…',
    'state.preparing': 'Preparing',
    'state.starting': 'Starting',
    'state.reachable': 'Service reachable',
    'state.ready': 'Ready',
    'state.degraded': 'Degraded',
    'state.updating': 'Updating',
    'state.failed': 'Failed',
    'state.stopping': 'Stopping',
    'state.stopped': 'Stopped',
    'state.cleanup_failed': 'Cleanup incomplete',
    'freshness.current': 'Up to date',
    'freshness.stale': 'Behind latest edits',
    'freshness.unverified': 'Freshness unverified',
  },
}

export async function apply(ctx: Context): Promise<void> {
  const t = ctx.locale.bind(namespace)
  await ctx.remote.$mount(remoteInfo)
  ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'page-preview.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-page-preview',
    kind: 'page-preview',
    keepMounted: true,
    title: () => t('title'),
    guide: [{
      id: 'page-preview.panel',
      order: 50,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }), 'page-preview.type')
  // Phase 0 实测约束（docs/phase0-verification.md）：动态 $mount 后必须 ctx.inject 声明具体 Remote 命名空间，
  // 否则 Cordis 拒绝访问 ctx.remote.pagePreview；会话目录同步后才可按会话跟随。2026-11-03 实机：
  // 之前直接访问导致面板与自动打开的跟随流一开始就被拒，Host 从未看到跟随者。
  await ctx.inject(['remote.pagePreview', 'sessions'], async scope => {
    // 本仓库单一 tsconfig 同时加载 Host（dsh-session）与 Client（dsh-api-session-controller）对 ctx.sessions 的
    // 模块扩充，类型解析成 Host 的 SessionStore；运行时这里是 Client 会话目录（Phase 0 探针同样调用 refresh）。
    await (scope.sessions as unknown as { refresh(): Promise<void> }).refresh()
    const follow = (sessionId: string, signal: AbortSignal) => {
      const stream = scope.remote.pagePreview.follow(sessionId, signal)
      signal.addEventListener('abort', () => stream.dispose(), { once: true })
      return stream
    }
    // 屏幕上会话新开的预览自动在 DSH Browser 页签展示（浏览器加载后回传挂载证据，open 据此等待）。
    scope.effect(() => startAutoOpen({
      mounted: scope.sidebarRight.mounted,
      follow,
      open: url => scope.sidebarRight.openTab('browser', { params: { url } }),
      report: error => scope.logger.error('page-preview auto-open stream failed: ' + String(error)),
    }), 'page-preview.auto-open')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: 'dsh-page-preview',
      locale: namespace,
      inject: (sessionId: string) => createPanelController(scope.remote.pagePreview, sessionId,
        url => scope.sidebarRight.openTab('browser', { params: { url } })),
    }, PreviewPanel))
  })
}
