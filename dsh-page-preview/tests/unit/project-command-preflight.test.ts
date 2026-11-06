/** 项目命令预检/执行边界（方案 §6.5、§8、§15.3）；只读元数据，未确认路径不分配资源。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { projectCommandAdapter } from '../../src/adapters/project-command/index.ts'
import { createFileLedger } from '../../src/shared/runner/ledger.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
const target: ResolvedTarget = { projectId: 'command', targetId: 'orders', selector: { kind: 'route', path: '/orders/:id', params: { id: '101' }, query: { tab: 'active' } }, scope: 'page' }

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-command-plan-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'cwd'))
  const sentinel = join(root, 'must-not-execute')
  const source = 'import{writeFileSync}from"node:fs";writeFileSync(' + JSON.stringify(sentinel) + ',"wrong")'
  await writeFile(join(root, 'command.mjs'), source)
  await writeFile(join(root, 'cwd', 'command.mjs'), source)
  const ctx: AdapterContext = { workspaceRoot: root, appRoot: root, profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] }, config: { source: { kind: 'detected' }, project: { id: 'command', root: '.', runtime: { command: { executable: process.execPath, args: ['command.mjs', '$(literal)'], cwd: 'cwd' }, requirements: [], readiness: { probePath: '/health', serviceDeadlineMs: 1000 } } }, diagnostics: [] } }
  return { root, sentinel, ctx }
}

test('project metadata probe/discover/plan performs no HTTP or command execution and preserves original bindings', async t => {
  const f = await setup(t)
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Preflight must not probe') })
  assert.equal((await projectCommandAdapter.probe(f.ctx)).matched, true)
  assert.equal((await projectCommandAdapter.discover(f.ctx)).manualOnly, true)
  const result = await projectCommandAdapter.plan(f.ctx, target)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan' || result.plan.process.kind !== 'managed') throw new Error('Expected a managed plan')
  assert.deepEqual(result.plan.process.args, ['command.mjs', '$(literal)'])
  assert.equal(result.plan.process.cwd, join(f.root, 'cwd'))
  assert.ok(result.plan.capabilities.network.every(value => value.control === 'none'))
  assert.equal(network.mock.callCount(), 0)
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' })
})

test('unmapped files, missing probes, nonconcrete navigation, required data boundaries and unsupported bindings fail readonly planning', async t => {
  const f = await setup(t)
  const runtime = f.ctx.config.project.runtime
  const context = (overrides: Partial<typeof runtime>): AdapterContext => ({ ...f.ctx, config: { ...f.ctx.config, project: { ...f.ctx.config.project, runtime: { ...runtime, ...overrides } } } })
  assert.equal((await projectCommandAdapter.plan(f.ctx, { ...target, selector: { kind: 'file', path: 'command.mjs' } })).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(context({ requirements: ['mock-only'] }), target)).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(context({ setup: 'command.mjs' }), target)).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(context({ readiness: {} }), target)).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(context({ command: { executable: join(f.root, 'missing-executable'), args: [], cwd: '.' } }), target)).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(context({ origin: 'http://example.com' }), target)).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(f.ctx, { ...target, selector: { kind: 'url', url: 'http://127.0.0.1:3000' } })).kind, 'missing')
  assert.equal((await projectCommandAdapter.plan(f.ctx, target, 'admin')).kind, 'missing')
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' })
})

test('an explicit file route and origin survive as navigation context without a fake source/current claim', async t => {
  const f = await setup(t)
  f.ctx.config.project.runtime.origin = 'http://127.0.0.1:3000'
  const file = { ...target, selector: { kind: 'file' as const, path: 'command.mjs' }, route: { path: '/orders/', query: { tab: 'active' } } }
  const result = await projectCommandAdapter.plan(f.ctx, file)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected an explicit mapped service')
  assert.deepEqual(result.plan.route, file.route)
  assert.equal(result.plan.fingerprints.sources, undefined)
})

test('project execution without the Runner verifier or with altered command arguments fails before allocating any process', async t => {
  const f = await setup(t)
  const result = await projectCommandAdapter.plan(f.ctx, target)
  if (result.kind !== 'plan') throw new Error('Expected a planned command')
  const ledger = createFileLedger(join(f.root, 'plugin'))
  const ctx = { ...f.ctx, previewId: 'test', ownerSessionId: 'synthetic-user', ledger, plan: result.plan, signal: new AbortController().signal, deadline: Date.now() + 1000, emit() {} }
  await assert.rejects(projectCommandAdapter.start(ctx), /verifier is not connected/)
  const changed = structuredClone(result.plan)
  if (changed.process.kind !== 'managed') throw new Error('Expected managed process')
  changed.process.args.push('altered')
  await assert.rejects(projectCommandAdapter.start({ ...ctx, plan: changed, verifyExecution: async () => {} }), /contradict/)
  assert.deepEqual(await ledger.listByPreview('test'), [])
  await assert.rejects(stat(f.sentinel), { code: 'ENOENT' })
})
