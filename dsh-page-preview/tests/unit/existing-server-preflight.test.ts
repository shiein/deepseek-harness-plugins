/** attach 只读契约（方案 §6.1、§6.6、§7.4、§15.3）；合成上下文只验证预检，网络另有独立进程实测。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existingServerAdapter } from '../../src/adapters/existing-server/index.ts'
import { attachmentUrls } from '../../src/adapters/existing-server/preflight.ts'
import type { AdapterContext } from '../../src/adapters/types.ts'
import type { RuntimeConfig } from '../../src/shared/config/schema.ts'
import type { ResolvedTarget } from '../../src/core/target/resolve.ts'

function context(runtime: RuntimeConfig = {}): AdapterContext {
  return { workspaceRoot: '/workspace', appRoot: '/workspace', profile: { root: '.', hasPackageJson: false, languages: [], frameworks: [], buildTools: [], runtime: {}, existingPreview: [] }, config: { source: { kind: 'detected' }, project: { id: 'existing', root: '.', runtime: { origin: 'http://127.0.0.1:3000', requirements: [], ...runtime } }, diagnostics: [] } }
}
const target: ResolvedTarget = { projectId: 'existing', targetId: 'orders', selector: { kind: 'route', path: '/orders/:id#detail', params: { id: 'a/b' }, query: { tab: 'overview' } }, scope: 'page' }

test('attach probe/discover/plan never contact the source; capabilities expose the uncontrolled observation boundary', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Preflight must never make network requests') })
  const ctx = context()
  assert.equal((await existingServerAdapter.probe(ctx)).matched, true)
  assert.equal((await existingServerAdapter.discover(ctx)).manualOnly, true)
  const result = await existingServerAdapter.plan(ctx, target)
  assert.equal(result.kind, 'plan')
  if (result.kind !== 'plan') throw new Error('Expected an observation plan')
  assert.equal(result.plan.process.kind, 'attach')
  assert.equal(result.plan.capabilities.captureCurrentView.status, 'unknown')
  assert.equal(result.plan.capabilities.runtimeErrors.status, 'unknown')
  assert.ok(result.plan.capabilities.network.every(value => value.control === 'none'))
  assert.equal(network.mock.callCount(), 0)
  assert.deepEqual(attachmentUrls(ctx, target), { origin: 'http://127.0.0.1:3000', url: 'http://127.0.0.1:3000/orders/a%2Fb?tab=overview#detail', probe: 'http://127.0.0.1:3000/orders/a%2Fb?tab=overview' })
})

test('file targets require an explicit route; configured route context survives into the plan', async () => {
  const file: ResolvedTarget = { ...target, selector: { kind: 'file', path: 'src/orders.vue' } }
  assert.equal((await existingServerAdapter.plan(context(), file)).kind, 'missing')
  const mapped = await existingServerAdapter.plan(context(), { ...file, route: { path: '/orders/', query: { mode: 'demo' } } })
  assert.equal(mapped.kind, 'plan')
  if (mapped.kind !== 'plan') throw new Error('Expected an explicit mapped route')
  assert.deepEqual(mapped.plan.route, { path: '/orders/', query: { mode: 'demo' } })
})

test('attach refuses default/required data boundaries, execution bindings and unsupported operations', async () => {
  for (const runtime of [
    { requirements: ['mock-only'] as const }, { requirements: ['isolated-target'] as const },
  ]) {
    const result = await existingServerAdapter.plan(context({ requirements: [...runtime.requirements] }), target)
    assert.equal(result.kind, 'missing')
    assert.ok(result.kind === 'missing' && result.missing.some(value => value.code === 'requirement_unsatisfied'))
  }
  for (const runtime of [{ setup: 'setup.js' }, { env: {} }, { entry: 'main.js' }, { publicRoot: '.' }]) assert.equal((await existingServerAdapter.plan(context(runtime), target)).kind, 'missing')
  assert.equal((await existingServerAdapter.plan(context(), target, 'admin')).kind, 'missing')
  const viewport = await existingServerAdapter.plan(context(), target, undefined, { requirements: [], viewport: { width: 800, height: 600 } })
  assert.equal(viewport.kind, 'unsupported')
  if (viewport.kind === 'unsupported') assert.match(viewport.reason, /viewport/i)
  assert.equal((await existingServerAdapter.plan(context(), { ...target, scope: 'component' })).kind, 'missing')
})

test('unconfigured origins, cross-origin URLs/probes, ambiguous routes and conflicting URL context fail preflight', async () => {
  for (const origin of ['', 'https://example.com', 'http://user:secret@localhost:3000', 'http://localhost:3000/path']) assert.equal((await existingServerAdapter.plan(context({ origin }), target)).kind, 'missing')
  assert.equal((await existingServerAdapter.plan(context({ readiness: { probePath: '//example.com/health' } }), target)).kind, 'missing')
  assert.equal((await existingServerAdapter.plan(context(), { ...target, selector: { kind: 'route', path: '/orders/:id' } })).kind, 'missing')
  const url: ResolvedTarget = { ...target, selector: { kind: 'url', url: 'http://localhost:3000/orders/' } }
  assert.equal((await existingServerAdapter.plan(context(), url)).kind, 'missing')
  const local = { ...url, selector: { kind: 'url' as const, url: 'http://127.0.0.1:3000/orders/' } }
  assert.equal((await existingServerAdapter.plan(context(), local, undefined, { requirements: [], route: { path: '/different' } })).kind, 'missing')
})
