/**
 * 侧边栏自动展示（方案 §10，2026-11-03 Aesc 需求）：跟随屏幕上的会话，把本会话新出现且已可达的预览
 * 自动在 DSH Browser 页签打开；浏览器加载后回传真实挂载证据，Agent 不必再自行截图验证。
 * 纯逻辑、无 React 依赖；跟随流与 Host 面板同源（PanelService.follow），不建第二份事实源。
 */
import type { PanelSnapshot } from './protocol.ts'

export interface MountedSession {
  getSnapshot(): string | undefined
  subscribe(listener: () => void): () => void
}

export interface AutoOpenDeps {
  mounted: MountedSession
  follow(sessionId: string, signal: AbortSignal): AsyncIterable<PanelSnapshot>
  open(url: string): void
  /** 跟随流异常结束时的可见上报（不吞异常）；默认写 console.error。 */
  report?(error: unknown): void
  /** 重连退避基数（毫秒），测试注入；默认 1 秒，上限 10 秒。 */
  retryMs?: number
}

const VISIBLE_STATES = ['reachable', 'ready', 'degraded']
const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 10_000

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * 判定规则：跟随开始时已带地址的预览视为「旧预览」，不自动弹出；之后才出现地址的预览各自动打开一次。
 * 切换会话会重新开始跟随；同一 previewId 在整个 Client 生命周期内至多自动打开一次。
 */
export function startAutoOpen(deps: AutoOpenDeps): () => void {
  const opened = new Set<string>()
  let control: AbortController | undefined
  let current: string | undefined
  const run = async (sessionId: string, signal: AbortSignal) => {
    const known = new Set<string>()
    let first = true
    // 跟随流可能因 Runner 重启、Host 断连等结束或抛错：会话仍在屏幕上就退避重连，不让自动打开永久失效。
    // 「旧预览」只按首次连接时的快照判定；重连期间新出现的可达预览照常自动打开。
    for (let attempt = 0; !signal.aborted; attempt++) {
      try {
        for await (const snapshot of deps.follow(sessionId, signal)) {
          if (signal.aborted) return
          attempt = 0
          for (const preview of snapshot.previews) {
            const visible = preview.url !== undefined && VISIBLE_STATES.includes(preview.state)
            if (first) {
              if (visible) known.add(preview.previewId)
              continue
            }
            if (!visible || known.has(preview.previewId) || opened.has(preview.previewId)) continue
            opened.add(preview.previewId)
            deps.open(preview.url!)
          }
          first = false
        }
      } catch (error) {
        if (!signal.aborted) (deps.report ?? (value => console.error('[dsh-page-preview] auto-open', value)))(error)
      }
      if (signal.aborted) return
      await wait(Math.min(RETRY_MAX_MS, (deps.retryMs ?? RETRY_BASE_MS) * 2 ** Math.min(attempt, 4)), signal)
    }
  }
  const follow = () => {
    const sessionId = deps.mounted.getSnapshot()
    if (sessionId === current) return
    control?.abort()
    control = undefined
    current = sessionId
    if (sessionId === undefined) return
    const next = new AbortController()
    control = next
    void run(sessionId, next.signal)
  }
  const unsubscribe = deps.mounted.subscribe(follow)
  follow()
  return () => {
    unsubscribe()
    control?.abort()
    control = undefined
    current = undefined
  }
}
