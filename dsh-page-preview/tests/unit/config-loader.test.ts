/** 配置来源与真实路径约束（方案 §8、§15.3）；仅使用临时文件，不执行配置中的命令和模块。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ConfigLoadError,
  loadEffectiveConfigs,
  localConfigDirectory,
  REPO_CONFIG_FILE,
} from '../../src/shared/config/loader.ts'
import { resolveProjectPath } from '../../src/shared/config/paths.ts'

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-config-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const workspace = join(dir, 'workspace')
  const dataDir = join(dir, 'plugin-data')
  const app = join(workspace, 'app')
  await mkdir(app, { recursive: true })
  const repo = join(workspace, REPO_CONFIG_FILE)
  return { dir, workspace, dataDir, app, repo }
}
const project = (id = 'sample') => ({ id, root: 'app', runtime: { strategy: 'static', adapter: 'static', publicRoot: '.' } })
async function config(file: string, projects: unknown[]) { await writeFile(file, JSON.stringify({ schemaVersion: 1, projects })) }
async function local(dataDir: string, workspace: string, id: string, value: unknown = project(id)) {
  const dir = await localConfigDirectory(dataDir, workspace)
  await mkdir(dir, { recursive: true })
  const path = join(dir, id + '.json')
  await config(path, [value])
  return path
}

test('repository selects one whole project source and reports ignored local config without merging it', async t => {
  const { workspace, dataDir, repo } = await setup(t)
  await config(repo, [project()])
  const ignored = await local(dataDir, workspace, 'sample', { ...project(), scenarios: { local: { props: { onlyLocal: true } } } })
  await writeFile(ignored, 'invalid ignored lower-priority content')
  const extra = await local(dataDir, workspace, 'another')
  const selected = await loadEffectiveConfigs(workspace, undefined, { dataDir })
  assert.deepEqual(selected.map(item => [item.project.id, item.source.kind]), [['sample', 'repo'], ['another', 'local']])
  assert.deepEqual(selected[0]?.project, project())
  assert.equal(selected[0]?.diagnostics[0]?.code, 'config_source_ignored')
  assert.equal(selected[0]?.diagnostics[0]?.location?.file, ignored)
  assert.deepEqual(selected[1]?.source, { kind: 'local', file: extra })
})

test('explicit selection reads only that complete source and never falls back when it is missing', async t => {
  const { dir, workspace, dataDir, repo } = await setup(t)
  await writeFile(repo, 'broken repository config')
  const explicit = join(dir, 'selected.json')
  await config(explicit, [project('selected')])
  const selected = await loadEffectiveConfigs(workspace, explicit, { dataDir })
  assert.deepEqual(selected, [{ project: project('selected'), source: { kind: 'explicit', file: explicit }, diagnostics: [] }])
  await assert.rejects(loadEffectiveConfigs(workspace, 'missing.json', { dataDir }), { code: 'ENOENT' })
})

test('local sources are keyed by canonical workspace path and isolated between workspaces', async t => {
  const { dir, workspace, dataDir } = await setup(t)
  const alias = join(dir, 'workspace-alias')
  await symlink(workspace, alias)
  assert.equal(await localConfigDirectory(dataDir, workspace), await localConfigDirectory(dataDir, alias))
  const other = join(dir, 'other-workspace')
  await mkdir(other)
  assert.notEqual(await localConfigDirectory(dataDir, workspace), await localConfigDirectory(dataDir, other))
  await local(dataDir, workspace, 'sample')
  assert.deepEqual(await loadEffectiveConfigs(other, undefined, { dataDir }), [])
})

test('absent configuration returns an empty list without writing files or guessing runtime defaults', async t => {
  const { dir, workspace, dataDir } = await setup(t)
  const before = await readdir(dir)
  assert.deepEqual(await loadEffectiveConfigs(workspace, undefined, { dataDir }), [])
  assert.deepEqual(await readdir(dir), before)
  await assert.rejects(access(dataDir), { code: 'ENOENT' })
  await assert.rejects(loadEffectiveConfigs('relative'), /absolute/)
})

test('invalid or unreadable repository sources do not silently fall back to valid local config', async t => {
  const { workspace, dataDir, repo } = await setup(t)
  await local(dataDir, workspace, 'sample')
  await writeFile(repo, '{"env":"synthetic-private-do-not-echo",')
  await assert.rejects(loadEffectiveConfigs(workspace, undefined, { dataDir }), error => {
    assert.ok(error instanceof ConfigLoadError)
    assert.deepEqual(error.issues, [{ path: '/', message: 'Invalid JSON' }])
    assert.doesNotMatch(String(error) + JSON.stringify(error.issues), /synthetic-private-do-not-echo/)
    return true
  })
  await rm(repo)
  await mkdir(repo)
  await assert.rejects(loadEffectiveConfigs(workspace, undefined, { dataDir }), { code: 'EISDIR' })
  await rm(repo, { recursive: true })
  await symlink(join(workspace, 'absent.json'), repo)
  await assert.rejects(loadEffectiveConfigs(workspace, undefined, { dataDir }), { code: 'ENOENT' })
})

test('local config filename must identify exactly one project', async t => {
  const { workspace, dataDir } = await setup(t)
  const path = await local(dataDir, workspace, 'sample', project('different'))
  await assert.rejects(loadEffectiveConfigs(workspace, undefined, { dataDir }), ConfigLoadError)
  await config(path, [project('sample'), project('extra')])
  await assert.rejects(loadEffectiveConfigs(workspace, undefined, { dataDir }), ConfigLoadError)
})

test('application roots cannot leave the workspace through traversal or symlinks', async t => {
  const { dir, workspace, app, repo } = await setup(t)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await config(repo, [{ ...project(), root: '../outside' }])
  await assert.rejects(loadEffectiveConfigs(workspace), ConfigLoadError)
  await rm(app, { recursive: true })
  await symlink(outside, app)
  await config(repo, [project()])
  await assert.rejects(loadEffectiveConfigs(workspace), ConfigLoadError)
})

test('module symlinks require an explicit dependency root; loader never executes the module', async t => {
  const { workspace, app, repo } = await setup(t)
  const shared = join(workspace, 'shared')
  await mkdir(shared)
  const module = join(shared, 'setup.js')
  await writeFile(module, "throw new Error('must never be executed by config loading')")
  await symlink(shared, join(app, 'linked'))
  const value = { ...project(), runtime: { ...project().runtime, setup: 'linked/setup.js' } }
  await config(repo, [value])
  await assert.rejects(loadEffectiveConfigs(workspace), error => error instanceof ConfigLoadError && error.issues[0]?.path === '/projects/0/runtime/setup')
  await config(repo, [{ ...value, runtime: { ...value.runtime, dependencyRoots: ['../shared'] } }])
  assert.equal((await loadEffectiveConfigs(workspace))[0]?.project.runtime.setup, 'linked/setup.js')
  assert.equal(await resolveProjectPath(app, 'linked/setup.js', ['../shared']), module)
  assert.equal(await readFile(module, 'utf8'), "throw new Error('must never be executed by config loading')")
})

test('missing files still resolve existing symlink parents and cannot escape through them', async t => {
  const { dir, app } = await setup(t)
  const outside = join(dir, 'outside')
  await mkdir(outside)
  await symlink(outside, join(app, 'linked'))
  await assert.rejects(resolveProjectPath(app, 'linked/not-created/file.js'), /outside/)
  assert.equal(await resolveProjectPath(app, 'not-created/file.js'), join(app, 'not-created/file.js'))
  await mkdir(app + '-other')
  await assert.rejects(resolveProjectPath(app, '../app-other/file.js'), /outside/)
  await symlink(join(dir, 'not-created-outside'), join(app, 'dangling'))
  await assert.rejects(resolveProjectPath(app, 'dangling/file.js'), /symbolic link/)
})

test('every configured file field uses the same application/dependency root rule', async t => {
  const { workspace, repo } = await setup(t)
  const escaped = '../../outside.js'
  const values = [
    { ...project(), runtime: { setup: escaped } }, { ...project(), runtime: { entry: escaped } },
    { ...project(), runtime: { publicRoot: escaped } }, { ...project(), runtime: { styles: [escaped] } },
    { ...project(), runtime: { command: { executable: 'node', args: [], cwd: escaped } } },
    { ...project(), targets: [{ id: 'home', selector: { kind: 'file', path: escaped } }] },
    { ...project(), scenarios: { sample: { handlers: escaped } } },
    { ...project(), scenarios: { sample: { http: [{ method: 'GET', path: '/', response: { status: 200, bodyFile: escaped } }] } } },
  ]
  for (const value of values) {
    await config(repo, [value])
    await assert.rejects(loadEffectiveConfigs(workspace), error => error instanceof ConfigLoadError && error.issues.length > 0)
  }
})

test('automatic config sources cannot follow a symlink outside their selected root or read env files', async t => {
  const { dir, workspace, repo } = await setup(t)
  const outside = join(dir, 'outside.json')
  await config(outside, [project()])
  await symlink(outside, repo)
  await assert.rejects(loadEffectiveConfigs(workspace), ConfigLoadError)
  await rm(repo)
  const env = join(workspace, '.env')
  await config(env, [project()]) // 合成测试文件，内容故意是合法 JSON；读取后解析无法替代“读取前拒绝”。
  await symlink(env, repo)
  await assert.rejects(loadEffectiveConfigs(workspace), error => error instanceof ConfigLoadError && error.issues[0]?.message === 'Environment files are not preview config sources')
})
