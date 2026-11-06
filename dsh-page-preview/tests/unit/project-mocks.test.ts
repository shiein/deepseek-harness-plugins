/** 项目 Mock 只读识别回归（方案 §7.2、R3-3、§15.3）；只断言识别证据，不执行任何项目模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectProjectMocks, describeProjectMocks } from '../../src/core/profile/project-mocks.ts'
import { loadProjectMock, projectMockEscapes } from '../../src/adapters/vite/project-mock.ts'
import { DiagnosticCode } from '../../src/shared/errors.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-mocks-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return { root, put }
}

test('manifest dependencies from every field produce candidate evidence in a stable order', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', {
    dependencies: { mockjs: '^1' },
    devDependencies: { msw: '2', 'not-a-mock': '1' },
    peerDependencies: { miragejs: '0.1' },
    optionalDependencies: { 'json-server': '0.17' },
  })
  const sources = await detectProjectMocks(root)
  assert.deepEqual(sources.map(source => source.kind), ['json-server', 'miragejs', 'mockjs', 'msw'])
  assert.ok(sources.every(source => source.confidence === 'candidate'))
  assert.deepEqual(sources.find(source => source.kind === 'msw')?.evidence, ['package.json devDependencies.msw'])
  assert.deepEqual(sources.find(source => source.kind === 'json-server')?.evidence,
    ['package.json optionalDependencies.json-server'])
  assert.ok(!JSON.stringify(sources).includes('not-a-mock'))
})

test('mock directories, *.mock.* files and mockServiceWorker produce file evidence with relative paths', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', {})
  await put('public/mockServiceWorker.js', '// msw worker')
  await put('mock/orders.ts', 'export default []')
  await put('src/mock/users.ts', 'export default []')
  await put('src/api.mock.ts', 'export const get = () => {}')
  await put('src/deep/nested.mock.mjs', 'export default {}')
  // 反例：扩展不匹配或名称不带 .mock. 分段的文件不命中。
  await put('src/api.mock.json', '{}')
  await put('src/mockup.ts', 'export {}')
  const sources = await detectProjectMocks(root)
  const msw = sources.find(source => source.kind === 'msw')
  const directory = sources.find(source => source.kind === 'mock-directory')
  assert.deepEqual(msw?.evidence, ['public/mockServiceWorker.js'])
  assert.equal(msw?.confidence, 'candidate')
  assert.ok(directory !== undefined)
  assert.deepEqual(directory?.evidence,
    ['mock/', 'src/api.mock.ts', 'src/deep/nested.mock.mjs', 'src/mock/'])
  assert.ok(!JSON.stringify(sources).includes('mockup'))
  assert.ok(!JSON.stringify(sources).includes('mock.json'))
})

test('quoted build-config references add config evidence and upgrade confidence to confirmed', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { devDependencies: { 'vite-plugin-mock': '3' } })
  await put('vite.config.ts', "import mock from 'vite-plugin-mock'\nexport default { plugins: [mock()] }")
  await put('webpack.config.js', '// comment mentions vite-plugin-mock without quotes, not evidence')
  await put('docs.config.js', "const x = 'msw'") // 非构建配置文件不读取
  const sources = await detectProjectMocks(root)
  const plugin = sources.find(source => source.kind === 'vite-plugin-mock')
  assert.equal(plugin?.confidence, 'confirmed')
  assert.deepEqual(plugin?.evidence,
    ['package.json devDependencies.vite-plugin-mock', 'vite.config.ts'])
  assert.ok(sources.every(source => source.kind !== 'msw'), 'unread config file must not contribute evidence')
})

test('vite-plugin-mock manifest plus its consumed mock directory corroborate each other', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { dependencies: { 'vite-plugin-mock': '3' } })
  await put('mock/list.ts', 'export default []')
  const sources = await detectProjectMocks(root)
  const plugin = sources.find(source => source.kind === 'vite-plugin-mock')
  assert.equal(plugin?.confidence, 'confirmed')
  assert.deepEqual(plugin?.evidence, ['mock/', 'package.json dependencies.vite-plugin-mock'])
  const directory = sources.find(source => source.kind === 'mock-directory')
  assert.equal(directory?.confidence, 'candidate')
  assert.deepEqual(directory?.evidence, ['mock/'])
})

test('.env content is never scanned or read as evidence; env-symlinked config is refused', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', {})
  await put('.env', 'MOCK="msw"\nSECRET=must-not-leak')
  await put('.env.production', "import 'vite-plugin-mock'")
  const sources = await detectProjectMocks(root)
  assert.deepEqual(sources, [])
  // 构建配置是指向 .env 的符号链接：scan 不采纳符号链接（isFile() 为 false），
  // env 内容既不被当配置解析，也不产生任何证据，探测如实完成。
  await symlink(join(root, '.env'), join(root, 'vite.config.js'))
  assert.deepEqual(await detectProjectMocks(root), [])
})

test('empty project reports no sources and describe output is empty', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', {})
  assert.deepEqual(await detectProjectMocks(root), [])
  assert.deepEqual(describeProjectMocks([]), { knownDifferences: [], diagnostics: [] })
})

// F6：复制前核实——mock 文件的相对导入越出 mockPath 时，temporaryRoot 副本必解析失败、
// vite-plugin-mock 3.0.2 静默降级为空表（路由表是模块私有变量，无法运行时核实），
// 静态检查是唯一诚实判定；type-only/裸导入/动态参数不误报。
test('mock files importing outside mockPath are reported as escapes (F6)', async t => {
  const { root, put } = await fixture(t)
  await put('mock/api.ts', `import { list } from '../src/data'
import mockjs from 'mockjs'
import type { Shape } from '../src/types'
const lazy = () => import('../outside/lazy')
const req = require('../also-outside')
export default [{ url: '/api/x', method: 'get', response: () => list }]`)
  await put('mock/data.ts', `import { helper } from './helper'
export * from '../src/re-export'
export default []`)
  await put('mock/helper.ts', 'export const helper = 1')
  await put('mock/readme.md', `import '../src/not-scanned'`)
  await put('src/data.ts', 'export const list = []')
  assert.deepEqual(await projectMockEscapes(root, 'mock'), [
    { file: 'api.ts', specifier: '../also-outside' },
    { file: 'api.ts', specifier: '../outside/lazy' },
    { file: 'api.ts', specifier: '../src/data' },
    { file: 'data.ts', specifier: '../src/re-export' },
  ])
  // 越界的 mock 目录在加载时视同加载失败——插件对象都还没解析就返回 undefined。
  assert.equal(await loadProjectMock(root, 'mock', join(root, '.tmp-mock')), undefined)
  // 无越界时不误报（本例插件未安装，loadProjectMock 随后如实失败；escapes 本身为空）。
  await put('mock/api.ts', `import { helper } from './helper'
import type { Shape } from '../src/types'
export default [{ url: '/api/x', method: 'get', response: () => helper }]`)
  await put('mock/data.ts', 'export default []')
  assert.deepEqual(await projectMockEscapes(root, 'mock'), [])
})

test('describe output is deterministic, carries every evidence path and points at an actionable next step', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { devDependencies: { msw: '2' } })
  await put('public/mockServiceWorker.js', '// worker')
  const first = await detectProjectMocks(root)
  const second = await detectProjectMocks(root)
  assert.deepEqual(first, second)
  const described = describeProjectMocks(first)
  assert.equal(described.knownDifferences.length, 1)
  const line = described.knownDifferences[0]!
  assert.ok(line.includes('confirmed') && line.includes('msw'))
  assert.ok(line.includes('package.json devDependencies.msw') && line.includes('public/mockServiceWorker.js'))
  // R5-1e：MSW 经入口重放的 worker.start() 启用，如实标注可能执行而非「从不执行」。
  assert.ok(line.includes('worker.start()'), 'msw detection must describe the entry-driven activation honestly')
  assert.equal(described.diagnostics.length, 1)
  const diagnostic = described.diagnostics[0]!
  assert.equal(diagnostic.code, DiagnosticCode.projectMockDetected)
  assert.equal(diagnostic.phase, 'plan')
  assert.ok(diagnostic.hint?.includes('handlers'), 'hint must name the scenario handlers module as the next step')
  // 执行集标注 Runner 实际执行的来源；其余来源仍如实不执行。
  const executed = describeProjectMocks(first, new Set(['vite-plugin-mock']))
  assert.ok(executed.knownDifferences[0]!.includes('worker.start()'))
  await put('package.json', { devDependencies: { 'vite-plugin-mock': '3' }, dependencies: { mockjs: '1' } })
  await put('mock/api.ts', 'export default []')
  await put('vite.config.ts', `import { viteMockServe } from 'vite-plugin-mock'`)
  const sources = await detectProjectMocks(root)
  const described2 = describeProjectMocks(sources, new Set(['vite-plugin-mock']))
  const pluginLine = described2.knownDifferences.find(value => value.includes('vite-plugin-mock'))
  assert.ok(pluginLine?.includes('executed by the Runner'), 'the executed source must say so')
  const mockLine = described2.knownDifferences.find(value => value.includes('mock-directory'))
  assert.ok(mockLine?.includes('never imported or executed'), 'non-executed sources stay honest')
})
