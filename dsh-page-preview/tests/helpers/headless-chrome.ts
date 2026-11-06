/** 本机 Google Chrome 无头实例 + CDP 客户端：真实浏览器 DOM/交互证据；如实标注 headless Chrome，不冒充 IAB。 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const candidates = process.env.DSH_PREVIEW_TEST_CHROME
  ? [process.env.DSH_PREVIEW_TEST_CHROME]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
export const CHROME = candidates.find(path => existsSync(path)) ?? candidates[0]!
export const chromeAvailable = (): boolean => existsSync(CHROME)

export interface ChromePage {
  navigate: (url: string) => Promise<void>
  evaluate: (expression: string) => Promise<unknown>
  /** 页面异常与 console 输出（Runtime.enable 后收集），用于失败诊断。 */
  events: () => string[]
  close: () => Promise<void>
}

/** CDP 单次调用上限：足量覆盖负载下的编译/渲染等待，又保证卡死的页面不会挂住整个测试进程。 */
const CDP_TIMEOUT_MS = 60_000
/** Chrome 启动各阶段上限；超时统一清理子进程与临时目录后抛出。 */
const LAUNCH_TIMEOUT_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const bounded = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
      }),
    ])
  } finally { clearTimeout(timer) }
}

/**
 * 启动 --headless=new + 自动端口的 Chrome，连上首个 page target；用户数据在临时目录，close 后清除。
 * 传入 node:test 的 TestContext 时，close 立即挂到 t.after：即使测试在中途超时或失败，
 * Chrome 子进程也会被回收，不会把调用它的测试文件挂到进程不退出。
 */
export const launchChrome = async (t?: { after: (fn: () => unknown) => void }): Promise<ChromePage> => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chrome-'))
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  const child: ChildProcess = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--user-data-dir=' + dir, '--no-first-run', '--disable-gpu',
    ...(root ? ['--no-sandbox'] : []), 'about:blank',
  ], { stdio: 'ignore' })
  let ws: WebSocket | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    ws?.close()
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
    await bounded(new Promise<void>(resolve => child.once('exit', () => resolve())), 10_000, 'Chrome exit')
      .catch(() => undefined)
    for (let i = 0; i < 20; i++) {
      try { await rm(dir, { recursive: true, force: true }); return } catch { await sleep(100) }
    }
    await rm(dir, { recursive: true, force: true })
  }
  t?.after(() => close())
  try {
    const portFile = join(dir, 'DevToolsActivePort')
    let port = 0
    const started = Date.now()
    while (Date.now() - started < LAUNCH_TIMEOUT_MS && !child.killed) {
      if (existsSync(portFile)) { port = Number((await readFile(portFile, 'utf8')).split('\n')[0]); break }
      await sleep(100)
    }
    if (!port) throw new Error('Chrome DevToolsActivePort never appeared')
    const list = await bounded(fetch('http://127.0.0.1:' + port + '/json').then(response => response.json()),
      LAUNCH_TIMEOUT_MS, 'Chrome target list')
    const targets = list as { type: string; webSocketDebuggerUrl: string }[]
    const page = targets.find(value => value.type === 'page')
    if (!page) throw new Error('No page target in Chrome')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    const socket = ws
    await bounded(new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('CDP WebSocket failed'))
      socket.onclose = () => reject(new Error('CDP WebSocket closed before open'))
    }), LAUNCH_TIMEOUT_MS, 'CDP WebSocket open')
    let id = 0
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
    const logs: string[] = []
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as
        { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      if (message.id === undefined) {
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params as
            { exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined
          const text = details?.exceptionDetails?.exception?.description
            ?? details?.exceptionDetails?.text ?? JSON.stringify(message.params)
          logs.push('EXCEPTION: ' + text.slice(0, 1200))
        } else if (message.method === 'Runtime.consoleAPICalled') {
          logs.push(JSON.stringify(message.params).slice(0, 400))
        }
        return
      }
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP error'))
      else waiter.resolve(message.result)
    }
    socket.onclose = () => {
      for (const waiter of pending.values()) waiter.reject(new Error('CDP WebSocket closed'))
      pending.clear()
    }
    const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      id += 1
      const call = id
      return await bounded(new Promise((resolve, reject) => {
        pending.set(call, { resolve, reject })
        try { socket.send(JSON.stringify({ id: call, method, params })) }
        catch (err) { pending.delete(call); reject(err instanceof Error ? err : new Error(String(err))) }
      }), CDP_TIMEOUT_MS, 'CDP ' + method)
    }
    await send('Runtime.enable', {})
    return {
      async navigate(url) { await send('Page.navigate', { url }) },
      async evaluate(expression) {
        const result = await send('Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true }) as
          { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
        if (result.exceptionDetails) {
          throw new Error('Page evaluate failed: ' + (result.exceptionDetails.text ?? 'unknown'))
        }
        return result.result?.value
      },
      events() { return [...logs] },
      close,
    }
  } catch (err) {
    await close()
    throw err
  }
}
