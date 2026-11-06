/** 真实静态预检（方案 §5.2、§6.1、§6.2、§6.8、§15.3）；临时原始文件，只读分析，不执行项目代码。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { staticAdapter } from '../../src/adapters/static/index.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'
import { buildPlan } from '../../src/core/plan/planner.ts'

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-static-plan-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await cp(new URL('../fixtures/static-multipage/', import.meta.url), join(root, 'public'), { recursive: true })
  const context: AdapterContext = { workspaceRoot: root, appRoot: root, config: { source: { kind: 'detected' }, project: { id: 'site', root: '.', runtime: { strategy: 'static', adapter: 'static', publicRoot: 'public' }, targets: [{ id: 'index', selector: { kind: 'file', path: 'public/index.html' } }] }, diagnostics: [] }, profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] } }
  const target: ResolvedTarget = { projectId: 'site', targetId: 'index', selector: { kind: 'file', path: 'public/index.html' }, scope: 'page' }
  const plan = () => staticAdapter.plan(context, target, undefined, { requirements: ['mock-only'] })
  return { root, context, target, plan }
}

test('real static adapter discovers original HTML and produces the common checked plan without package.json', async t => {
  const f = await setup(t)
  const discovered = await staticAdapter.discover(f.context)
  assert.deepEqual(discovered.candidates.map(value => value.selector).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ kind: 'file', path: 'public/index.html' }, { kind: 'file', path: 'public/second.html' }])
  assert.equal((await staticAdapter.probe(f.context, f.target)).matched, true)
  assert.equal((await staticAdapter.probe(f.context, { ...f.target, selector: { kind: 'file', path: 'component.vue' } })).matched, false)
  const result = await buildPlan({ workspaceRoot: f.root, config: f.context.config, profile: f.context.profile, target: f.target, strategy: 'auto', adapters: [staticAdapter] })
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected actual static adapter plan')
  assert.equal(result.plan.process.kind, 'in-runner')
  assert.equal(result.plan.requirements[0], 'mock-only')
  assert.ok(result.plan.fingerprints.sources)
  assert.equal(result.plan.capabilities.isolatedRender.status, 'unsupported')
  assert.equal(result.plan.capabilities.network.find(value => value.channel === 'service-worker')?.control, 'block')
})

test('known module/worker dependencies affect source hashes while source code is never executed', async t => {
  const f = await setup(t)
  await writeFile(join(f.root, 'public/index.html'), '<!doctype html><script type="module" src="main.js"></script>')
  await writeFile(join(f.root, 'public/main.js'), 'import "./other.js"; new Worker("./worker.js"); throw new Error("MUST NOT EXECUTE")')
  await writeFile(join(f.root, 'public/other.js'), 'export const value = 1')
  const first = await f.plan()
  assert.equal(first.kind, 'plan')
  await writeFile(join(f.root, 'public/other.js'), 'export const value = 2')
  const second = await f.plan()
  assert.ok(first.kind === 'plan' && second.kind === 'plan')
  assert.notEqual(first.plan.fingerprints.sources, second.plan.fingerprints.sources)
  assert.equal(first.plan.fingerprints.config, second.plan.fingerprints.config)
})

test('missing, bare or external dependencies return missing conditions without fetching or substituting', async t => {
  const f = await setup(t)
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Preflight must not access a server') })
  for (const source of ['<script src="missing.js"></script>', '<script type="module">import { createApp } from "vue"</script>', '<script src="https://example.com/library.js"></script>', '<base href="https://example.com/"><script src="app.js"></script>']) {
    await writeFile(join(f.root, 'public/index.html'), source)
    const result = await f.plan()
    assert.ok(result.kind === 'missing' && result.missing.length > 0)
  }
  assert.equal(network.mock.callCount(), 0)
})

test('browser JS syntax, JSX and TypeScript are checked through AST rather than file suffix alone', async t => {
  const f = await setup(t)
  await writeFile(join(f.root, 'public/index.html'), '<script type="module" src="main.js"></script>')
  for (const source of ['export const value: string = "typed"', 'export const View = () => <div/>', 'export const broken = ;']) {
    await writeFile(join(f.root, 'public/main.js'), source)
    const result = await f.plan()
    assert.ok(result.kind === 'missing' && result.missing.some(value => value.code === 'unsupported_capability'))
  }
})

test('explicit SPA uses the actual navigation base and missing assets never fall back to index', async t => {
  const f = await setup(t)
  f.target.selector = { kind: 'route', path: '/users/:id', params: { id: '42' } }
  assert.equal((await f.plan()).kind, 'missing')
  f.context.config.project.runtime.spaFallback = true
  assert.equal((await f.plan()).kind, 'plan')
  await writeFile(join(f.root, 'public/index.html'), '<script src="./app.js"></script>')
  assert.equal((await f.plan()).kind, 'missing')
  await writeFile(join(f.root, 'public/index.html'), '<base href="/"><script src="./app.js"></script>')
  assert.equal((await f.plan()).kind, 'plan')
})

test('unimplemented scenario, export, scope, viewport and initialization fail while configured DOM assertions are retained', async t => {
  const f = await setup(t)
  assert.equal((await staticAdapter.plan(f.context, f.target, 'role')).kind, 'missing')
  assert.equal((await staticAdapter.plan(f.context, { ...f.target, scope: 'component' })).kind, 'missing')
  const viewport = await staticAdapter.plan(f.context, f.target, undefined, { requirements: ['mock-only'], viewport: { width: 390, height: 844 } })
  assert.equal(viewport.kind, 'unsupported')
  if (viewport.kind === 'unsupported') assert.match(viewport.reason, /viewport/i)
  assert.equal((await staticAdapter.plan(f.context, { ...f.target, selector: { kind: 'file', path: 'public/index.html', exportName: 'default' } })).kind, 'missing')
  f.context.config.project.targets![0]!.assertions = [{ kind: 'text-present', text: 'Required' }]
  const asserted = await f.plan()
  assert.equal(asserted.kind, 'plan')
  if (asserted.kind !== 'plan') throw new Error('Expected original document with explicit DOM assertion')
  assert.deepEqual(asserted.plan.readiness.assertions, [{ kind: 'text-present', text: 'Required' }])
  assert.equal(asserted.plan.capabilities.readinessAssertion.status, 'supported')
  delete f.context.config.project.targets![0]!.assertions
  f.context.config.project.runtime.env = { SYNTHETIC: 'do-not-echo' }
  const result = await f.plan()
  assert.equal(result.kind, 'missing')
  assert.doesNotMatch(JSON.stringify(result), /do-not-echo/)
})

test('publicRoot and environment-file aliases use the same boundary as the actual HTTP service', async t => {
  const f = await setup(t)
  await writeFile(join(f.root, '.env.test'), 'SYNTHETIC=do-not-read')
  await symlink('../.env.test', join(f.root, 'public/escape.js'))
  await writeFile(join(f.root, 'public/index.html'), '<script src="escape.js"></script>')
  assert.equal((await f.plan()).kind, 'missing')
  await writeFile(join(f.root, 'outside.html'), '<h1>Outside publicRoot</h1>')
  f.target.selector = { kind: 'file', path: 'outside.html' }
  assert.equal((await f.plan()).kind, 'missing')
})

test('discovery excludes hidden, dependency and generated directories and meta CSP reports conditional observation', async t => {
  const f = await setup(t)
  for (const directory of ['.hidden', 'node_modules', 'dist']) {
    await mkdir(join(f.root, 'public', directory))
    await writeFile(join(f.root, 'public', directory, 'ignored.html'), '<h1>Excluded</h1>')
  }
  assert.equal((await staticAdapter.discover(f.context)).candidates.length, 2)
  await writeFile(join(f.root, 'public/index.html'), '<meta http-equiv="Content-Security-Policy" content="connect-src none"><h1>Original</h1>')
  const result = await f.plan()
  assert.ok(result.kind === 'plan' && result.plan.capabilities.runtimeErrors.status === 'conditional')
})

test('static initial HTTP scenarios preserve requirements and fixture fingerprints while rejecting unbound data', async t => {
  const f = await setup(t)
  const scene = { businessPaths: ['/api/**'], http: [{ method: 'GET', path: '/api/value', response: { status: 200, bodyFile: 'reply.json' } }] }
  f.context.config.project.scenarios = { own: scene }
  await writeFile(join(f.root, 'reply.json'), '{"value":1}')
  const build = () => buildPlan({ workspaceRoot: f.root, config: f.context.config, profile: f.context.profile, target: f.target, strategy: 'static', scenario: 'own', adapters: [staticAdapter] })
  const first = await build()
  assert.ok(first.kind === 'plan')
  assert.deepEqual(first.plan.requirements, ['mock-only'])
  assert.equal(first.plan.scenario, 'own')
  assert.equal(first.plan.capabilities.network.find(value => value.channel === 'browser-http')?.control, 'mock')
  assert.equal(first.plan.capabilities.scenarioReset.status, 'unsupported')
  await writeFile(join(f.root, 'reply.json'), '{"value":2}')
  const changed = await build()
  assert.ok(changed.kind === 'plan')
  assert.notEqual(changed.plan.fingerprints.sources, first.plan.fingerprints.sources)
  assert.notEqual(changed.plan.fingerprints.scenario, first.plan.fingerprints.scenario)
  // R5-1c：显式 origin 的 fixture 经共享 remote 通道按原 origin 匹配，static 同样放行。
  const crossOrigin = { ...scene, http: [{ ...scene.http[0]!, origin: 'https://example.invalid' }] }
  f.context.config.project.scenarios = { own: crossOrigin }
  assert.equal((await build()).kind, 'plan')
  for (const invalid of [{ ...scene, businessPaths: [] }, { ...scene, props: {} },
    { ...scene, permissions: [] }, { ...scene, handlers: 'never-import.mjs' }]) {
    f.context.config.project.scenarios = { own: invalid }
    assert.equal((await build()).kind, 'needs-configuration')
  }
})
