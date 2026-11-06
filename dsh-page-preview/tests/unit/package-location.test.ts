/** 项目工具链位置（方案 §6.5、§6.9）；只读有界 node_modules 元数据，不解析/执行包入口。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installedPackageVersion, resolveInstalledPackage } from '../../src/shared/profile.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-package-location-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, value: unknown) => { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)) }
  await mkdir(join(root, 'workspace/apps/web'), { recursive: true })
  return { root, workspace: join(root, 'workspace'), app: join(root, 'workspace/apps/web'), put }
}

test('hoisted actual location and version share one lookup and a local invalid version shadows its ancestor', async t => {
  const f = await fixture(t)
  await f.put('workspace/node_modules/vite/package.json', { name: 'vite', version: '5.2.12', main: './index.js' })
  await f.put('workspace/node_modules/vite/index.js', 'throw new Error("PACKAGE_ENTRY_MUST_NOT_RUN")')
  assert.deepEqual(await resolveInstalledPackage(f.app, f.workspace, 'vite'), { directory: join(f.workspace, 'node_modules/vite'), version: '5.2.12' })
  assert.equal(await installedPackageVersion(f.app, f.workspace, 'vite'), '5.2.12')
  await f.put('workspace/apps/web/node_modules/vite/package.json', { name: 'vite', version: '^5' })
  assert.deepEqual(await resolveInstalledPackage(f.app, f.workspace, 'vite'), { directory: join(f.app, 'node_modules/vite') })
  assert.equal(await installedPackageVersion(f.app, f.workspace, 'vite'), undefined)
})

test('pnpm package links retain their real directory but undeclared ancestors are never searched', async t => {
  const f = await fixture(t)
  await f.put('store/vue/package.json', { name: 'vue', version: '3.4.27' })
  await mkdir(join(f.workspace, 'node_modules'), { recursive: true })
  await symlink(join(f.root, 'store/vue'), join(f.workspace, 'node_modules/vue'))
  assert.deepEqual(await resolveInstalledPackage(f.app, f.workspace, 'vue'), { directory: join(f.root, 'store/vue'), version: '3.4.27' })
  await f.put('node_modules/vite/package.json', { name: 'vite', version: '5.2.12' })
  assert.equal(await resolveInstalledPackage(f.app, f.workspace, 'vite'), undefined)
})

test('corrupt, mismatched or broken package metadata fails instead of falling back', async t => {
  const f = await fixture(t)
  await f.put('workspace/node_modules/vite/package.json', { name: 'vite', version: '5.2.12' })
  await f.put('workspace/apps/web/node_modules/vite/package.json', '{broken')
  await assert.rejects(resolveInstalledPackage(f.app, f.workspace, 'vite'), /project metadata/)
  await f.put('workspace/apps/web/node_modules/vite/package.json', { name: 'different', version: '5.2.12' })
  await assert.rejects(resolveInstalledPackage(f.app, f.workspace, 'vite'), /project metadata/)
  await rm(join(f.app, 'node_modules/vite/package.json'))
  await symlink(join(f.root, 'missing'), join(f.app, 'node_modules/vite/package.json'))
  await assert.rejects(resolveInstalledPackage(f.app, f.workspace, 'vite'), /project metadata/)
  await assert.rejects(resolveInstalledPackage(f.app, f.workspace, '../private'), /package name/)
  await assert.rejects(resolveInstalledPackage(f.workspace, f.app, 'vite'), /outside the declared workspace/)
})
