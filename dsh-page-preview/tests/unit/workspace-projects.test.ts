/** 同源应用推断与配置优先级（方案 §5.1、§8、§15.3）；不启动应用、不写批准记录。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadWorkspaceProjects } from '../../src/shared/config/projects.ts'
import { localConfigDirectory } from '../../src/shared/config/loader.ts'

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-apps-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace')
  const dataDir = join(directory, 'data')
  await mkdir(join(workspace, 'app'), { recursive: true })
  await mkdir(join(workspace, 'second'))
  await writeFile(join(workspace, 'app/index.html'), '<p>original app</p>')
  await writeFile(join(workspace, 'second/index.html'), '<p>second app</p>')
  return { directory, workspace, dataDir }
}
const project = { id: 'saved', root: 'app', runtime: { strategy: 'static', adapter: 'static' } }
const document = (projects: unknown[]) => JSON.stringify({ schemaVersion: 1, projects })

test('no-config applications get stable IDs from canonical workspace-relative roots without writing config', async t => {
  const { directory, workspace, dataDir } = await setup(t)
  const alias = join(directory, 'alias')
  await symlink(workspace, alias)
  const direct = await loadWorkspaceProjects(workspace, undefined, { dataDir })
  assert.deepEqual(await loadWorkspaceProjects(alias, undefined, { dataDir }), direct)
  assert.deepEqual(direct.map(value => value.config.project.root), ['app', 'second'])
  assert.ok(direct.every(value => value.config.source.kind === 'detected' && value.config.project.id.startsWith('app-')))
  assert.deepEqual(direct[0]?.config.project.runtime, {})
  assert.equal(direct[0]?.profile.hasPackageJson, false)
})

test('configured root wins as a whole while unrelated detected roots and local sources remain separate', async t => {
  const { workspace, dataDir } = await setup(t)
  await writeFile(join(workspace, 'page-preview.config.json'), document([project]))
  const localDir = await localConfigDirectory(dataDir, workspace)
  await mkdir(localDir, { recursive: true })
  await writeFile(join(localDir, 'saved.json'), '{broken lower priority')
  const apps = await loadWorkspaceProjects(workspace, undefined, { dataDir })
  assert.equal(apps.length, 2)
  assert.deepEqual(apps[0]?.config.project, project)
  assert.equal(apps[0]?.config.source.kind, 'repo')
  assert.equal(apps[0]?.config.diagnostics[0]?.code, 'config_source_ignored')
  assert.equal(apps[1]?.config.source.kind, 'detected')
  assert.equal(apps[1]?.config.project.root, 'second')
})

test('explicit selection never adds automatic applications or reads unrelated broken workspace metadata', async t => {
  const { directory, workspace, dataDir } = await setup(t)
  const selected = join(directory, 'selected.json')
  await writeFile(selected, document([project]))
  await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: [')
  await writeFile(join(workspace, 'page-preview.config.json'), '{broken')
  const apps = await loadWorkspaceProjects(workspace, selected, { dataDir })
  assert.equal(apps.length, 1)
  assert.equal(apps[0]?.config.source.kind, 'explicit')
  assert.equal(apps[0]?.profile.root, 'app')
  await assert.rejects(loadWorkspaceProjects(workspace, 'missing.json', { dataDir }), { code: 'ENOENT' })
  await assert.rejects(loadWorkspaceProjects(workspace, undefined, { dataDir }))
})

test('an explicit generated root is inspected even though discovery excludes it', async t => {
  const { workspace } = await setup(t)
  await mkdir(join(workspace, 'dist'))
  await writeFile(join(workspace, 'dist/index.html'), '<p>artifact</p>')
  await writeFile(join(workspace, 'page-preview.config.json'), document([{ id: 'artifact', root: 'dist', runtime: { adapter: 'static' } }]))
  const apps = await loadWorkspaceProjects(workspace)
  const artifact = apps.find(value => value.config.project.id === 'artifact')
  assert.ok(artifact?.profile.languages.some(value => value.value === 'html'))
  assert.equal(apps.filter(value => value.config.project.root === 'dist').length, 1)
})

test('configured application ownership prevents ordinary HTML child folders becoming duplicate applications', async t => {
  const { workspace } = await setup(t)
  await writeFile(join(workspace, 'page-preview.config.json'), document([{ id: 'whole', root: '.', runtime: { adapter: 'static' } }]))
  assert.deepEqual((await loadWorkspaceProjects(workspace)).map(value => value.config.project.id), ['whole'])
})
