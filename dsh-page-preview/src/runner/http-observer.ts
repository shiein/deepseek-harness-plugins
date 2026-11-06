/** 服务 HTTP 就绪/存活观察（方案 §9.2）；仅受控 loopback 探针，不带凭据、不跟随重定向、不输出正文。 */
import { setTimeout as delay } from 'node:timers/promises'
import { loopbackUrl } from '../shared/route.ts'

export async function probeHttpService(url: string, signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (!loopbackUrl(url)) throw new Error('Service probe must use an HTTP(S) loopback URL without credentials')
  const response = await fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(Math.max(1, timeoutMs), 2147483647))]) })
  await response.body?.cancel()
  if (!response.ok) throw new Error('Configured service probe returned a non-success response')
}

/** 终止只取消本观察器。资源所属进程的清理由调用者负责。 */
export function observeHttpService(url: string, parent: AbortSignal, onFailure: () => void): { stop(): Promise<void> } {
  const stopped = new AbortController()
  const signal = AbortSignal.any([parent, stopped.signal])
  const task = (async () => {
    while (!signal.aborted) {
      try {
        await delay(1000, undefined, { signal, ref: false })
        await probeHttpService(url, signal, 2000)
      } catch {
        if (signal.aborted) return
        onFailure()
        return
      }
    }
  })()
  return { async stop() { stopped.abort(); await task } }
}
