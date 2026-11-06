/** 只读应用画像回归（方案 §5.1、§8、§15.3）；临时多应用清单、假配置与元数据，不执行任何项目模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectApps, inspectApp, ProjectReadError } from '../../src/shared/profile.ts'
import { scanProjectFiles } from '../../src/shared/project-files.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-profile-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: unknown) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return { root, put }
}

test('npm workspace application boundaries and installed versions remain separate candidate evidence', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { private: true, workspaces: { packages: ['apps/*', '!apps/ignored'] } })
  await put('apps/web/package.json', { dependencies: { vue: '^3.0.0', vite: '^5' }, engines: { node: '>=18' }, packageManager: 'pnpm@9.1.0', scripts: { preview: 'DO_NOT_EXECUTE_SECRET', build: 'not a preview' } })
  await put('apps/web/browser/main.js', 'const target = <Card />')
  await put('apps/web/vite.config.ts', 'throw new Error("must not execute configuration")')
  await put('apps/legacy/package.json', { dependencies: { vue: '^2.6.0', '@vue/cli-service': '~4.5.0', msw: '2' } })
  await put('apps/legacy/src/main.ts', 'throw new Error("must not execute source")')
  await put('apps/legacy/node_modules/vue/package.json', { name: 'vue', version: '2.7.16' })
  await put('node_modules/vue/package.json', { name: 'vue', version: '3.5.13' })
  await put('node_modules/vite/package.json', { name: 'vite', version: '5.4.0' })
  await put('apps/ignored/package.json', '{broken ignored manifest')
  await put('node_modules/false-app/package.json', { dependencies: { react: '19' } })
  const apps = await detectApps(root)
  assert.deepEqual(apps.map(app => app.root), ['apps/legacy', 'apps/web'])
  assert.deepEqual(apps.map(app => app.frameworks[0]?.value), [{ name: 'vue', version: '2.7.16' }, { name: 'vue', version: '3.5.13' }])
  assert.ok(apps.flatMap(app => app.frameworks).every(value => value.confidence === 'candidate'))
  assert.equal(apps[0]?.buildTools[0]?.value.version, undefined)
  assert.equal(apps[1]?.runtime.declaredNode, '>=18')
  assert.equal(apps[1]?.runtime.node, undefined)
  assert.equal(apps[1]?.runtime.packageManager, 'pnpm@9.1.0')
  assert.ok(apps[1]?.languages.some(value => value.value === 'js' && value.evidence.some(item => item.includes('browser/main.js'))))
  assert.ok(apps[0]?.existingPreview.some(value => value.value.kind === 'msw'))
  assert.equal(apps[1]?.existingPreview[0]?.value.ref, 'package.json#scripts.preview')
  assert.ok(!JSON.stringify(apps).includes('DO_NOT_EXECUTE_SECRET'))
})

test('pnpm globs include non-package HTML apps and exclude explicitly negated workspace members', async t => {
  const { root, put } = await fixture(t)
  await put('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "!./apps/excluded"\n')
  await put('apps/plain/index.html', '<h1>original</h1>')
  await put('apps/plain/deep/other.html', '<p>second page, same app</p>')
  await put('apps/plain/lib/component.jsx', 'export const item = <p />')
  await put('apps/excluded/index.html', '<p>not selected</p>')
  await put('outside/package.json', { dependencies: { react: '19' } })
  const apps = await detectApps(root)
  assert.deepEqual(apps.map(app => app.root), ['apps/plain'])
  assert.equal(apps[0]?.hasPackageJson, false)
  assert.deepEqual(apps[0]?.buildTools.map(value => value.value.name), ['none'])
  assert.ok(apps[0]?.languages.some(value => value.value === 'jsx'))
})

test('static root grouping is deterministic and ignores generated roots until explicitly selected', async t => {
  const { root, put } = await fixture(t)
  await put('pages/deep/first.html', '<p>deep created first</p>')
  await put('pages/index.html', '<p>parent</p>')
  await put('dist/index.html', '<p>explicit artifact</p>')
  await put('.hidden/index.html', '<p>hidden</p>')
  await symlink(join(root, 'pages'), join(root, 'linked'))
  assert.deepEqual((await detectApps(root)).map(app => app.root), ['pages'])
  const explicit = await inspectApp(root, join(root, 'dist'))
  assert.equal(explicit.root, 'dist')
  assert.ok(explicit.languages.some(value => value.value === 'html'))
})

test('build configurations are filename evidence, never imported or used to execute source', async t => {
  const { root, put } = await fixture(t)
  const sentinel = join(root, 'was-executed')
  await put('vue.config.js', 'require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "wrong"); throw Error("wrong")')
  await put('src/main.ts', 'throw Error("wrong")')
  const [app] = await detectApps(root)
  assert.equal(app?.buildTools[0]?.value.name, 'vue-cli')
  assert.equal(app?.buildTools[0]?.confidence, 'candidate')
  assert.deepEqual(app?.frameworks, [])
  await assert.rejects(access(sentinel), { code: 'ENOENT' })
})

test('nested applications do not contribute source language evidence to their parent', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', {})
  await put('index.html', '<p>root app</p>')
  await put('child/package.json', { dependencies: { vue: '3' } })
  await put('child/page.vue', '<template><p /></template>')
  const apps = await detectApps(root)
  const parent = apps.find(value => value.root === '.')
  const child = apps.find(value => value.root === 'child')
  assert.deepEqual(parent?.languages.map(value => value.value), ['html'])
  assert.ok(child?.languages.some(value => value.value === 'vue-sfc'))
  assert.equal(child?.frameworks[0]?.value.version, undefined)
})

test('a workspace root with its own framework remains a candidate alongside declared members', async t => {
  const { root, put } = await fixture(t)
  await put('package.json', { workspaces: ['packages/*'], dependencies: { vue: '3' } })
  await put('src/main.js', 'export default 1')
  await put('packages/other/package.json', { dependencies: { svelte: '5' } })
  const apps = await detectApps(root)
  assert.deepEqual(apps.map(value => value.root), ['.', 'packages/other'])
  assert.equal(apps[0]?.frameworks[0]?.value.name, 'vue')
  assert.equal(apps[1]?.frameworks[0]?.value.name, 'svelte')
})

test('existing invalid metadata, directories, dangling links and environment aliases do not fall back', async t => {
  const { root, put } = await fixture(t)
  await put('index.html', '<p>cannot hide invalid metadata</p>')
  for (const value of ['{broken', 'null', '{"workspaces":["!../escape"]}', '{"dependencies": []}', '{"scripts":null}']) {
    await put('package.json', value)
    await assert.rejects(detectApps(root), ProjectReadError)
  }
  await rm(join(root, 'package.json'))
  await mkdir(join(root, 'package.json'))
  await assert.rejects(detectApps(root), ProjectReadError)
  await rm(join(root, 'package.json'), { recursive: true })
  await symlink(join(root, 'missing'), join(root, 'package.json'))
  await assert.rejects(detectApps(root), ProjectReadError)
  await rm(join(root, 'package.json'))
  await put('.env.secret', 'DO_NOT_READ')
  await symlink(join(root, '.env.secret'), join(root, 'package.json'))
  await assert.rejects(detectApps(root), error => error instanceof ProjectReadError && !error.message.includes('DO_NOT_READ'))
})

test('invalid workspace YAML and installed package metadata fail explicitly without script execution', async t => {
  const { root, put } = await fixture(t)
  await put('pnpm-workspace.yaml', 'packages: [')
  await assert.rejects(detectApps(root), ProjectReadError)
  await rm(join(root, 'pnpm-workspace.yaml'))
  await put('package.json', { dependencies: { vue: '^3' }, packageManager: 'npm@1_SECRET', engines: { node: 'arbitrary secret' } })
  let [app] = await detectApps(root)
  assert.equal(app?.runtime.packageManager, undefined)
  assert.equal(app?.runtime.declaredNode, undefined)
  assert.equal(app?.frameworks[0]?.value.version, undefined)
  await put('node_modules/vue/package.json', '{invalid installed manifest')
  await assert.rejects(detectApps(root), ProjectReadError)
})

test('bounded scans expose incompleteness and empty workspaces do not invent applications', async t => {
  const { root, put } = await fixture(t)
  assert.deepEqual(await detectApps(root), [])
  await put('a/file.js', '')
  await put('b/file.ts', '')
  const scan = await scanProjectFiles(root, 2)
  assert.equal(scan.limited, true)
})
