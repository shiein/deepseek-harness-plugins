/** bootstrap 的 pageText 采集节流（R4-3，r4-3 测试债）：首帧立即、变化合并、pagehide 清理。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const script = await readFile(new URL('../../src/browser/bootstrap.js', import.meta.url), 'utf8')

interface PageTextReport { kind: string; url?: string; text?: string; truncated?: boolean }

async function harness() {
  const reports: PageTextReport[] = []
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const listeners = new Map<string, Array<() => void>>()
  let id = 0
  interface ObserverOptions {
    attributeFilter?: string[]; attributes?: boolean; childList?: boolean; subtree?: boolean; characterData?: boolean
  }
  let observed: { target: unknown; options: ObserverOptions } | undefined
  let disconnected = false
  let mutationCallback: (() => void) | undefined
  class FakeMutationObserver {
    constructor(callback: () => void) { mutationCallback = callback }
    observe(target: unknown, options: never) { observed = { target, options } }
    disconnect() { disconnected = true }
  }
  const document = {
    body: { innerText: 'initial text' },
    addEventListener(name: string, callback: () => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), callback])
    },
    querySelectorAll() { return [] },
  }
  const window = {
    addEventListener(name: string, callback: () => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), callback])
    },
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' } },
    __DSH_PREVIEW__: undefined as { mounted(detail?: string): void; report?(payload: unknown): void } | undefined,
  }
  const config = { previewId: 't', nonce: 'n', assertions: [], targetDeadlineMs: 500 }
  const location = { href: 'http://127.0.0.1:9/owned', reload() { } }
  const navigator = {
    sendBeacon(_url: string, body: string) { reports.push(JSON.parse(body).report as PageTextReport); return true },
  }
  const setInterval = (callback: () => void) => { intervals.set(++id, callback); return id }
  const clearInterval = (key: number) => { intervals.delete(key) }
  const setTimeout = (callback: () => void) => { timeouts.set(++id, callback); return id }
  const clearTimeout = (key: number) => { timeouts.delete(key) }
  runInNewContext(script.replace('/*__DSH_PREVIEW_CONFIG__*/ null', JSON.stringify(config)), {
    document, window, location, navigator, setInterval, clearInterval, setTimeout, clearTimeout,
    MutationObserver: FakeMutationObserver,
  })
  const pageTexts = () => reports.filter(report => report.kind === 'page-text')
  return {
    document, pageTexts,
    loaded: () => { for (const callback of listeners.get('DOMContentLoaded') ?? []) callback() },
    mount: () => window.__DSH_PREVIEW__!.mounted(),
    mutate: () => mutationCallback!(),
    fireTimeouts: () => { for (const callback of [...timeouts.values()]) callback() },
    pagehide: () => { for (const callback of listeners.get('pagehide') ?? []) callback() },
    observed: () => observed, disconnected: () => disconnected,
    pendingTimeouts: () => timeouts.size,
  }
}

test('first frame reports page text immediately on document load', async () => {
  const f = await harness()
  assert.equal(f.pageTexts().length, 0)
  f.loaded()
  const texts = f.pageTexts()
  assert.equal(texts.length, 1)
  assert.equal(texts[0]?.text, 'initial text')
  assert.equal(texts[0]?.url, 'http://127.0.0.1:9/owned')
})

test('DOM mutations are coalesced into at most one report per interval window', async () => {
  const f = await harness()
  f.loaded()
  f.document.body.innerText = 'changed once'
  f.mutate(); f.mutate(); f.mutate()
  // 变化合并：定时器只排一次，触发前不发新报告。
  assert.equal(f.pageTexts().length, 1)
  f.fireTimeouts()
  assert.equal(f.pageTexts().length, 2)
  assert.equal(f.pageTexts()[1]?.text, 'changed once')
  // 下一窗口内内容未变则去重不发。
  f.mutate(); f.fireTimeouts()
  assert.equal(f.pageTexts().length, 2)
  f.document.body.innerText = 'changed twice'
  f.mutate(); f.fireTimeouts()
  assert.equal(f.pageTexts().length, 3)
})

test('mounted flushes pending text immediately without waiting for the interval', async () => {
  const f = await harness()
  f.loaded()
  f.document.body.innerText = 'mounted text'
  f.mutate()
  f.mount()
  const texts = f.pageTexts()
  assert.equal(texts.length, 2)
  assert.equal(texts[1]?.text, 'mounted text')
  // mounted 已清掉挂起的定时器，后续 flush 不产生重复报告。
  f.fireTimeouts()
  assert.equal(f.pageTexts().length, 2)
})

test('pagehide disconnects the observer and clears the pending timer', async () => {
  const f = await harness()
  f.loaded()
  const observer = f.observed()
  assert.ok(observer, 'MutationObserver should observe the body')
  assert.equal(observer.options.subtree, true)
  assert.equal(observer.options.childList, true)
  assert.equal(observer.options.characterData, true)
  assert.equal(observer.options.attributes, true)
  // attributeFilter 在 VM 内创建（跨 realm 数组），序列化后比较。
  assert.equal(JSON.stringify(observer.options.attributeFilter), JSON.stringify(['class', 'style', 'hidden', 'open']))
  f.document.body.innerText = 'before hide'
  f.mutate()
  f.pagehide()
  assert.equal(f.disconnected(), true)
  assert.equal(f.pendingTimeouts(), 0)
  f.fireTimeouts()
  assert.equal(f.pageTexts().length, 1, 'no report after pagehide')
})
