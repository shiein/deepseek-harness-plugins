/** 静态站点影响分析（方案 §5.2、R3-4）：真实临时 publicRoot 的 HTML/CSS 引用追溯。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { impactStatic } from '../../src/adapters/static/impact.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { FileChange } from '../../src/core/change/baseline.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-static-impact-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const ctx: AdapterContext = {
    workspaceRoot: root, appRoot: root,
    profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [],
      buildTools: [], runtime: {}, existingPreview: [] },
    config: { source: { kind: 'detected' },
      project: { id: 'site', root: '.', runtime: { publicRoot: 'public' } }, diagnostics: [] },
  }
  const modified = (path: string): FileChange => ({ kind: 'modified', path, origin: 'workspace-observed' })
  return { root, put, ctx, modified }
}

const HTML = (references: string) =>
  '<!doctype html><html><head>' + references + '</head><body>page</body></html>'

test('an HTML document change is a strong self-edge; referenced resources reach their pages', async t => {
  const { ctx, put, modified } = await fixture(t)
  await put('public/index.html', HTML('<script src="app.js"></script><link rel="stylesheet" href="site.css">'))
  await put('public/about.html', HTML('<img src="logo.png">'))
  await put('public/app.js', 'console.log(1)')
  await put('public/logo.png', 'png')
  const impact = await impactStatic(ctx, [modified('public/index.html'), modified('public/app.js'),
    modified('public/logo.png'), modified('private/secret.txt')])
  const page = impact.edges.find(value => value.changed === 'public/index.html')
  assert.deepEqual(page?.selector, { kind: 'file', path: 'public/index.html' })
  assert.equal(page?.evidence, 'strong')
  const script = impact.edges.find(value => value.changed === 'public/app.js')
  assert.equal(script?.evidence, 'strong', 'a single referencing page stays strong')
  assert.deepEqual(script?.selector, { kind: 'file', path: 'public/index.html' })
  const image = impact.edges.find(value => value.changed === 'public/logo.png')
  assert.deepEqual(image?.selector, { kind: 'file', path: 'public/about.html' })
  // publicRoot 之外的文件不是可服务资源。
  assert.ok(impact.unrelated.includes('private/secret.txt'))
  assert.equal(impact.manualOnly, false)
})

test('a resource shared by several pages produces medium edges for every page', async t => {
  const { ctx, put, modified } = await fixture(t)
  await put('public/a.html', HTML('<link rel="stylesheet" href="shared.css">'))
  await put('public/b.html', HTML('<link rel="stylesheet" href="shared.css">'))
  await put('public/shared.css', 'body { color: red }')
  const impact = await impactStatic(ctx, [modified('public/shared.css')])
  assert.equal(impact.edges.length, 2)
  assert.ok(impact.edges.every(value => value.evidence === 'medium'))
  assert.deepEqual(impact.edges.map(value => (value.selector as { path: string }).path).sort(),
    ['public/a.html', 'public/b.html'])
})

test('CSS @import and url() literals inherit the referencing document as one hop', async t => {
  const { ctx, put, modified } = await fixture(t)
  await put('public/index.html', HTML('<link rel="stylesheet" href="main.css">'))
  await put('public/main.css', "@import 'theme.css'; .a { background: url('bg.png') }")
  await put('public/theme.css', '')
  await put('public/bg.png', '')
  const impact = await impactStatic(ctx, [modified('public/theme.css'), modified('public/bg.png')])
  for (const file of ['public/theme.css', 'public/bg.png']) {
    const edge = impact.edges.find(value => value.changed === file)
    assert.deepEqual(edge?.selector, { kind: 'file', path: 'public/index.html' }, file)
    assert.equal(edge?.evidence, 'strong')
  }
})

test('external, data: and unverifiable references are skipped; deleted files keep importer edges', async t => {
  const { ctx, put, modified } = await fixture(t)
  await put('public/index.html', HTML(
    '<script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="data:text/css,x">'
      + '<img src="/logo.png"><script src="app.js"></script>'))
  await put('public/app.js', '')
  const impact = await impactStatic(ctx,
    [modified('public/app.js'), { kind: 'deleted', path: 'public/old.html', origin: 'workspace-observed' }])
  // 已删除的 HTML 不产生自身的 file 候选（selector 无法解析），只留下引用边语义。
  assert.ok(!impact.edges.some(value =>
    (value.selector as { path?: string }).path === 'public/old.html'))
  assert.deepEqual(impact.edges.map(value => value.changed), ['public/app.js'])
  assert.ok(!JSON.stringify(impact).includes('cdn.example.com'))
})
