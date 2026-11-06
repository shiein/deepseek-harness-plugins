/** 场景重载/切换：Runner 只读复核与 worker 可换 Mock（方案 §7.4、§11；R3-2）；真实文件与 HTTP，不起项目进程。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareScenarioUpdate } from '../../src/runner/scenario-reload.ts'
import { createSwappableScenario } from '../../src/adapters/scenario-swap.ts'
import { collectExecutionItems, executionFingerprint } from '../../src/shared/config/fingerprint.ts'
import type { PreviewPlan } from '../../src/shared/contracts.ts'

async function workspace(t: { after(callback: () => Promise<void>): void }, runtime: object,
  scenarios: Record<string, object>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-scenario-reload-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const put = async (path: string, content: string) => {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await put('page-preview.config.json', JSON.stringify({ schemaVersion: 1,
    projects: [{ id: 'web', root: '.', runtime, scenarios }] }))
  const plan = { projectId: 'web', scenario: 'first', fingerprints: {} } as unknown as PreviewPlan
  const input = { workspaceRoot: root, dataDir: join(root, '.data'), plan }
  return { root, put, input, plan }
}

test('same-scenario reload fingerprints edited fixture bytes without approval drift', async t => {
  const scene = { businessPaths: ['/api/**'],
    http: [{ method: 'GET', path: '/api/orders', response: { status: 200, bodyFile: 'fixtures/orders.json' } }] }
  const { put, input } = await workspace(t, {}, { first: scene })
  await put('fixtures/orders.json', '[{"id":1}]')
  const before = await prepareScenarioUpdate(input)
  assert.equal(before.name, 'first')
  await put('fixtures/orders.json', '[{"id":2}]')
  const after = await prepareScenarioUpdate(input)
  assert.notEqual(after.fingerprint, before.fingerprint, 'fixture byte edits must change the scenario fingerprint')
})

test('switching scenarios returns the new scenario data (identity/permissions/props) for re-render', async t => {
  const { input } = await workspace(t, {}, {
    first: { props: { title: 'One' } },
    second: { identity: { user: 'admin' }, permissions: ['read', 'write'], props: { title: 'Two' } },
  })
  const update = await prepareScenarioUpdate({ ...input, scenario: 'second' })
  assert.equal(update.name, 'second')
  assert.deepEqual(update.scenario.identity, { user: 'admin' })
  assert.deepEqual(update.scenario.permissions, ['read', 'write'])
  assert.deepEqual(update.scenario.props, { title: 'Two' })
  assert.notEqual(update.fingerprint, (await prepareScenarioUpdate(input)).fingerprint)
})

test('changed execution items or handler bindings are rejected before touching the worker', async t => {
  const { put, input } = await workspace(t, {},
    { first: { handlers: 'handlers.ts' }, second: { handlers: 'other.ts' } })
  await put('handlers.ts', 'export default {}')
  await put('other.ts', 'export default {}')
  // 无批准或指纹不符 → config_changed_needs_approval，不进入 worker 更新。
  await assert.rejects(prepareScenarioUpdate(input), /changed since approval/)
  await assert.rejects(prepareScenarioUpdate({ ...input, approval: { fingerprint: 'bogus' } }),
    /changed since approval/)
  // 已批准指纹一致：同 handler 绑定的场景可切，换了 handler 绑定的场景被拒。
  const approved = executionFingerprint(
    await collectExecutionItems(input.workspaceRoot,
      { id: 'web', root: '.', runtime: {},
        scenarios: { first: { handlers: 'handlers.ts' }, second: { handlers: 'other.ts' } } }))
  await assert.rejects(prepareScenarioUpdate({ ...input, scenario: 'second',
    approval: { fingerprint: approved }, initialHandlers: 'handlers.ts' }),
    /would change the loaded project handler module/)
})

test('missing or unknown scenario bindings are config errors, not silent fallbacks', async t => {
  const { input, plan } = await workspace(t, {}, { first: {} })
  await assert.rejects(prepareScenarioUpdate({ ...input, scenario: 'ghost' }),
    /not configured/)
  const noScenario = { ...plan, scenario: undefined } as unknown as PreviewPlan
  await assert.rejects(prepareScenarioUpdate({ ...input, plan: noScenario }),
    /no scenario to reload/)
})

test('swappable scenario serves the new fixture set and keeps the old one when replace fails', async t => {
  const unmatched: string[] = []
  const swappable = createSwappableScenario({
    previewOrigin: 'http://preview.invalid', appRoot: '/nonexistent',
    handlers: [], onUnmatched: request => unmatched.push(request.url),
    onDiagnostic: () => undefined,
    initial: { name: 'first', scenario: { businessPaths: ['/api/**'],
      http: [{ method: 'GET', path: '/api/one', response: { status: 200, body: 'v1' } }] } },
  })
  const server = createServer((req, res) => swappable.middleware(req, res,
    () => { res.writeHead(418); res.end('forwarded') }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const after = () => new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()))
  t.after(after)
  const address = server.address()
  const origin = 'http://127.0.0.1:' + (typeof address === 'object' && address ? address.port : 0)
  const get = (path: string) => fetch(origin + path, { signal: AbortSignal.timeout(3000) })
  assert.equal(await (await get('/api/one')).text(), 'v1')
  // handler 绑定不同 → 替换被拒且旧场景仍一致服务。
  assert.throws(() => swappable.replace('evil', { handlers: 'changed.ts' }), /handler module/)
  assert.equal(swappable.current, 'first')
  assert.equal(await (await get('/api/one')).text(), 'v1')
  // 正常替换：新 fixture 生效，旧 fixture 未命中如实 unmatched。
  swappable.replace('second', { businessPaths: ['/api/**'],
    http: [{ method: 'GET', path: '/api/two', response: { status: 200, body: 'v2' } }] })
  assert.equal(swappable.current, 'second')
  assert.equal(await (await get('/api/two')).text(), 'v2')
  assert.equal((await get('/api/one')).status, 404)
  assert.ok(unmatched.includes('/api/one'), 'old fixtures must not answer after replacement')
})
