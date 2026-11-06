/**
 * Client apply 的 Remote 访问边界（docs/phase0-verification.md）：动态 $mount 后 Cordis 只允许经
 * ctx.inject(['remote.pagePreview', ...]) 的 scope 访问该命名空间。2026-11-03 实机：直接访问使面板与自动打开失效。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** react 由 DSH 宿主模块表提供、仓库不安装：按产品打包方式构建 Client，再以只含 react/zod 的 require 加载。 */
async function loadClient(): Promise<{ apply(ctx: unknown): Promise<void> }> {
  const entry = fileURLToPath(new URL('../../src/client/index.ts', import.meta.url))
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'cjs',
    target: 'es2018', write: false, external: ['react', 'react/jsx-runtime', 'zod'] })
  const zod = createRequire(import.meta.url)('zod')
  const react = { createElement: () => null, useEffect() {}, useState: (value: unknown) => [value, () => {}] }
  const module = { exports: {} as Record<string, unknown> }
  const require = (name: string) => name === 'zod' ? zod : name === 'react' ? react : (() => {
    throw new Error('missed the module table: ' + name)
  })()
  new Function('module', 'exports', 'require', result.outputFiles[0]!.text)(module, module.exports, require)
  return module.exports as { apply(ctx: unknown): Promise<void> }
}

test('client apply reaches remote.pagePreview only through the injected scope and starts auto-open', async () => {
  const calls: string[] = []
  const disposers: Array<() => void> = []
  const followed: string[] = []
  let mountedListener: (() => void) | undefined
  const remote = {
    async $mount() { calls.push('mount') },
    get pagePreview(): never { throw new Error('remote.pagePreview accessed without ctx.inject') },
  }
  const scopedRemote = {
    pagePreview: {
      follow(sessionId: string) {
        followed.push(sessionId)
        return { dispose() {}, async *[Symbol.asyncIterator]() {} }
      },
      async stop() { return { ok: true } },
    },
  }
  const sidebarRight = {
    mounted: { getSnapshot: () => 'S1', subscribe: (fn: () => void) => { mountedListener = fn; return () => {} } },
    openTab() {},
  }
  const base = {
    locale: { bind: () => (key: string) => key, register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
    sidebarRight,
    logger: { error() {} },
    effect: (fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(() => { dispose() })
    },
  }
  const ctx = {
    ...base, remote,
    async inject(names: string[], callback: (scope: unknown) => Promise<void>) {
      calls.push('inject:' + names.join(','))
      await callback({ ...base, remote: scopedRemote, sessions: { async refresh() { calls.push('refresh') } } })
    },
  }
  // 测试替身只实现 apply 用到的字段；完整 Cordis Context 与本边界无关。
  await (await loadClient()).apply(ctx)
  assert.deepEqual(calls, ['mount', 'inject:remote.pagePreview,sessions', 'refresh'])
  assert.deepEqual(followed, ['S1'], 'auto-open follows the on-screen session through the scope')
  assert.ok(mountedListener, 'auto-open subscribes to on-screen session changes')
  for (const dispose of disposers) dispose()
})
