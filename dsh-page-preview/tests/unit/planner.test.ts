/** 通用计划预检（方案 §6.2、§7.3、§8、§15.3）；合成只读适配器只检验契约，不作为产品支持证据。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlan } from '../../src/core/plan/planner.ts'
import type { PlanInput } from '../../src/core/plan/planner.ts'
import type { Adapter } from '../../src/adapters/types.ts'
import type { Capability, PreviewPlan, Strategy } from '../../src/shared/contracts.ts'
import { fingerprintJson } from '../../src/shared/fingerprint.ts'
import { collectExecutionItems, fingerprintExecutionItems } from '../../src/shared/config/fingerprint.ts'
const supported = { status: 'supported', source: 'adapter', coverage: ['Synthetic preflight contract only'] } satisfies Capability
const unsupported = { status: 'unsupported', source: 'none', reason: 'Synthetic missing capability' } satisfies Capability

async function setup(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-plan-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), '<h1>Original source</h1>')
  const input: PlanInput = { workspaceRoot: root, config: { source: { kind: 'detected' }, project: { id: 'app', root: '.', runtime: {}, targets: [{ id: 'home', selector: { kind: 'file', path: 'index.html' } }] }, diagnostics: [] }, profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] }, target: { projectId: 'app', targetId: 'home', selector: { kind: 'file', path: 'index.html' }, scope: 'page' }, strategy: 'auto', adapters: [] }
  const calls: string[] = []
  function adapter(id: string, strategy: Strategy, change?: (plan: PreviewPlan) => void): Adapter {
    return {
      id, version: '1', strategies: [strategy],
      features: { scenarios: false, targetAssertions: false, isolatedTarget: false },
      async probe() { calls.push(id + ':probe'); return { matched: true, evidence: ['Synthetic fixture'], capabilities: { isolatedRender: strategy === 'isolated' ? supported : unsupported }, limits: [] } },
      async discover() { throw new Error('Planner must not discover or execute a target') },
      async start() { throw new Error('Planner must never execute a target') },
      async plan(context, target, scenario, options) {
        calls.push(id + ':plan')
        const plan: PreviewPlan = {
          projectId: target.projectId, targetId: target.targetId, selector: structuredClone(target.selector), scope: target.scope, strategy, adapter: { id, version: '1' }, toolchain: {}, requirements: [...(options?.requirements ?? ['mock-only'])],
          ...(scenario === undefined ? {} : { scenario }), ...(options?.viewport ? { viewport: { ...options.viewport } } : {}), ...(options?.route ? { route: structuredClone(options.route) } : {}),
          process: strategy === 'project' ? { kind: 'managed', executable: process.execPath, args: [], cwd: context.appRoot } : strategy === 'attach' ? { kind: 'attach', origin: 'http://localhost:1234' } : { kind: 'in-runner' },
          readiness: { serviceDeadlineMs: 1000, targetDeadlineMs: 1000 }, capabilities: { scopes: { page: supported, component: supported, shell: supported }, isolatedRender: strategy === 'isolated' ? supported : unsupported, scenarioApply: scenario === undefined ? unsupported : supported, scenarioReset: unsupported, refresh: unsupported, captureCurrentView: unsupported, runtimeErrors: supported, readinessAssertion: unsupported, network: ['browser-http', 'browser-ws', 'browser-sse', 'service-worker'].map(channel => ({ channel: channel as 'browser-http' | 'browser-ws' | 'browser-sse' | 'service-worker', control: 'block', location: 'response-layer' })) },
          fingerprints: { config: fingerprintJson(context.config.project) }, missing: [], knownDifferences: ['Synthetic adapter is not a product validation'],
        }
        change?.(plan)
        return { kind: 'plan', plan }
      },
    }
  }
  input.adapters = [adapter('static-fixture', 'static')]
  return { input, root, calls, adapter }
}

test('auto plans preserve requirements and choose the smallest matching path without starting anything', async t => {
  const { input, adapter, calls } = await setup(t)
  input.adapters = [adapter('isolated-fixture', 'isolated'), ...input.adapters]
  const result = await buildPlan(input)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected a checked plan')
  assert.equal(result.plan.strategy, 'static')
  assert.deepEqual(result.plan.requirements, ['mock-only'])
  assert.deepEqual(calls.filter(value => value.endsWith(':plan')), ['static-fixture:plan'])
  input.requirements = ['mock-only', 'isolated-target']
  const isolated = await buildPlan(input)
  assert.ok(isolated.kind === 'plan' && isolated.plan.strategy === 'isolated')
})

test('saved/default requirements cannot be relaxed and duplicate requirements are rejected before probing', async t => {
  const { input, calls } = await setup(t)
  for (const requirements of [[], ['mock-only', 'mock-only']] as const) {
    input.requirements = [...requirements]
    const result = await buildPlan(input)
    assert.equal(result.kind, 'needs-configuration')
  }
  assert.deepEqual(calls, [])
})

test('explicit adapter/strategy binding and scope are preserved, not silently replaced', async t => {
  const { input, adapter } = await setup(t)
  input.config.project.runtime.adapter = 'configured'
  input.adapters = [adapter('configured', 'isolated'), adapter('other', 'static')]
  assert.ok((await buildPlan(input)).kind === 'plan')
  input.strategy = 'static'
  assert.equal((await buildPlan(input)).kind, 'unsupported')
  delete input.config.project.runtime.adapter
  input.strategy = 'auto'
  input.adapters = [adapter('configured', 'static', plan => { plan.capabilities.scopes.page = unsupported })]
  assert.equal((await buildPlan(input)).kind, 'unsupported')
  input.adapters = [adapter('configured', 'static', plan => { plan.capabilities.scopes.page = { status: 'unknown', source: 'none' } })]
  assert.equal((await buildPlan(input)).kind, 'plan', 'Unknown capability is not a gate (§0.3)')
})

test('overlapping adapters need configuration and a selected plan failure never tries a larger strategy', async t => {
  const { input, adapter, calls } = await setup(t)
  input.adapters = [...input.adapters, adapter('also-static', 'static')]
  const ambiguous = await buildPlan(input)
  assert.ok(ambiguous.kind === 'needs-configuration' && ambiguous.missing[0]?.code === 'ambiguous_target')
  assert.equal(calls.some(value => value.endsWith(':plan')), false)
  input.adapters = [adapter('broken', 'static', plan => { plan.missing = [{ code: 'dependency_missing', phase: 'plan', message: 'Fixture missing dependency' }] }), adapter('larger', 'project')]
  const broken = await buildPlan(input)
  assert.equal(broken.kind, 'needs-configuration')
  assert.equal(calls.includes('larger:plan'), false)
})

test('scenario selection is explicit then target default and route/viewport context survives planning', async t => {
  const { input } = await setup(t)
  input.config.project.targets![0]!.defaultScenario = 'default'
  input.config.project.scenarios = { default: { route: { path: '/default' } }, explicit: { route: { path: '/explicit' } } }
  input.viewport = { width: 390, height: 844 }
  const defaults = await buildPlan(input)
  assert.ok(defaults.kind === 'plan' && defaults.plan.scenario === 'default' && defaults.plan.route?.path === '/default')
  input.scenario = 'explicit'
  input.target.route = { path: '/selected', query: { tab: 'details' } }
  const selected = await buildPlan(input)
  assert.ok(selected.kind === 'plan' && selected.plan.scenario === 'explicit')
  assert.deepEqual(selected.plan.route, input.target.route)
  assert.deepEqual(selected.plan.viewport, input.viewport)
  input.scenario = 'missing'
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
})

test('selecting a scenario requires actual application capability, not merely copying its name', async t => {
  const { input, adapter } = await setup(t)
  input.config.project.scenarios = { own: { props: { count: 1 } } }
  input.scenario = 'own'
  input.adapters = [adapter('unsupported-scene', 'static', plan => { plan.capabilities.scenarioApply = unsupported })]
  assert.equal((await buildPlan(input)).kind, 'unsupported')
  input.adapters = [adapter('unknown-scene', 'static', plan => { plan.capabilities.scenarioApply = { status: 'unknown', source: 'adapter' } })]
  assert.equal((await buildPlan(input)).kind, 'plan', 'Unknown scenario capability is not a gate (§0.3)')
})

test('plans cannot contradict selector, scope, scenario, ownership, viewport or configuration and omit assertions', async t => {
  const { input, adapter } = await setup(t)
  const changes: Array<(plan: PreviewPlan) => void> = [
    plan => { plan.selector = { kind: 'file', path: 'another.html' } }, plan => { plan.scope = 'shell' }, plan => { plan.strategy = 'project' }, plan => { plan.fingerprints.config = 'stale' }, plan => { plan.requirements = [] }, plan => { plan.process = { kind: 'attach', origin: 'http://localhost:1' } }, plan => { delete plan.viewport }, plan => { plan.route = { path: '/another' } },
  ]
  input.viewport = { width: 390, height: 844 }
  for (const change of changes) {
    input.adapters = [adapter('changed', 'static', change)]
    assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  }
  input.config.project.targets![0]!.assertions = [{ kind: 'text-present', text: 'Required target content' }]
  input.adapters = [adapter('changed', 'static')]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
})

test('mock-only checks all required browser channels and project server/proxy coverage, never accepts observation', async t => {
  const { input, adapter } = await setup(t)
  input.adapters = [adapter('partial', 'static', plan => { plan.capabilities.network.push({ channel: 'browser-http', control: 'observe', location: 'carrier' }) })]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.adapters = [adapter('partial', 'static', plan => { plan.capabilities.network = plan.capabilities.network.filter(value => value.channel !== 'service-worker') })]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.config.project.runtime.strategy = 'project'
  input.config.project.runtime.command = { executable: process.execPath, args: [], cwd: '.' }
  input.adapters = [adapter('project-fixture', 'project')]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  delete input.config.project.runtime.command
  input.config.project.runtime.strategy = 'attach'
  input.config.project.runtime.origin = 'http://localhost:1234'
  input.adapters = [adapter('attach-fixture', 'attach')]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.config.project.runtime.requirements = []
  input.requirements = []
  assert.equal((await buildPlan(input)).kind, 'plan')
})

test('mock-only with a selected Node handler also requires server-process control on an isolated path', async t => {
  const { input, root, adapter } = await setup(t)
  await writeFile(join(root, 'handlers.mjs'), 'throw new Error("PLANNER_MUST_NOT_IMPORT"); export default []')
  input.config.project.scenarios = { own: { handlers: 'handlers.mjs' }, browserOnly: {} }
  input.scenario = 'own'
  input.strategy = 'isolated'
  input.approvals = { async isApproved() { return true } } // 只读合成检查，不写任何批准记录。
  const isolated = (control?: 'mock' | 'block' | 'observe' | 'none', location: 'adapter' | 'none' = 'adapter') => adapter('isolated-fixture', 'isolated', plan => {
    if (control) plan.capabilities.network.push({ channel: 'server-process', control, location })
  })
  for (const control of [undefined, 'none', 'observe'] as const) {
    input.adapters = [isolated(control)]
    const result = await buildPlan(input)
    assert.ok(result.kind === 'needs-configuration' && result.missing[0]?.code === 'requirement_unsatisfied')
  }
  input.adapters = [isolated('mock', 'none')]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  for (const control of ['mock', 'block'] as const) {
    input.adapters = [isolated(control)]
    assert.equal((await buildPlan(input)).kind, 'plan')
  }
  input.adapters = [isolated()]
  input.scenario = 'browserOnly'
  assert.equal((await buildPlan(input)).kind, 'plan', 'Unselected handlers do not add a fictitious business server to this plan')
})

test('execution fingerprints are read-checked and never approved or executed by the planner', async t => {
  const { input, root } = await setup(t)
  input.config.project.runtime.env = { SYNTHETIC: 'must-not-echo-value' }
  const unapproved = await buildPlan(input)
  assert.ok(unapproved.kind === 'needs-configuration' && unapproved.missing[0]?.code === 'config_changed_needs_approval')
  assert.doesNotMatch(JSON.stringify(unapproved.missing), /must-not-echo-value/)
  const expected = fingerprintExecutionItems(await collectExecutionItems(root, input.config.project))
  const checked: string[] = []
  input.approvals = { async isApproved(workspace, project, fingerprint) { assert.equal(workspace, root); assert.equal(project, 'app'); checked.push(fingerprint); return fingerprint === expected } }
  assert.equal((await buildPlan(input)).kind, 'plan')
  assert.deepEqual(checked, [expected])
  input.config.project.runtime.env.SYNTHETIC = 'changed'
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
})

test('application mismatch, unsupported capability evidence and absent adapters fail explicitly', async t => {
  const { input, adapter } = await setup(t)
  input.target.projectId = 'another'
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.target.projectId = 'app'
  await mkdir(join(input.workspaceRoot, 'different-app'))
  input.profile.root = 'different-app'
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.profile.root = '.'
  input.adapters = [adapter('unproven', 'static', plan => { plan.capabilities.scopes.page = { status: 'supported', source: 'none' } })]
  assert.equal((await buildPlan(input)).kind, 'needs-configuration')
  input.adapters = []
  assert.equal((await buildPlan(input)).kind, 'unsupported')
})
