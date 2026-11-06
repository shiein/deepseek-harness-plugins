/** 自有 Vite 的真实 WebSocket Upgrade 边界（方案 §6.8、§7.3、§15.3）；仅本地自建业务 listener，无真实后端。 */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { vueViteAdapter } from '../../src/adapters/vue/vite/index.ts'
import { createVueViteFixture } from '../helpers/vue-vite-fixture.ts'
import type { RunningHandle } from '../../src/adapters/types.ts'
import { VITE_HMR_PATH } from '../../src/adapters/vue/vite/protocol.ts'
import { hasUpgradeGate } from '../../src/adapters/vite/network.ts'
import { testModules as modules, strict, integrationSkip } from '../helpers/test-gate.ts'

const options = { skip: integrationSkip || (!hasUpgradeGate() && !strict), timeout: 30000 }
async function upgrade(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; upgraded: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
    req.setTimeout(3000, () => req.destroy(new Error('Owned upgrade probe timed out')))
    req.once('error', reject)
    req.once('response', res => { res.resume(); res.once('end', () => resolve({ status: res.statusCode ?? 0, upgraded: false })) })
    req.once('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, upgraded: true }) })
    req.end()
  })
}

test('only the owned same-origin HMR socket reaches project upgrade listeners', options, async t => {
  if (!modules) throw new Error('Explicit existing toolchain required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) assert.deepEqual(await running.stop(), { residual: [] }); await f.cleanup() })
  const marker = join(f.root, 'business-socket-reached')
  let source = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  source = `import {createHash} from 'node:crypto'\n` + source.replace('plugins: [', `plugins: [{name:'own-business-socket',configureServer(vite) {
    vite.config.server.hmr.server.on('upgrade', (req,socket) => {
      if (new URL(req.url,'http://fixture.invalid').pathname !== '/api/socket') return
      writeFileSync(${JSON.stringify(marker)},'BUSINESS_LISTENER_REACHED')
      const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n')
    })
  }},`)
  source = source.replace('resolve: { alias:', "server:{hmr:{path:'/project-hmr',host:'different.invalid',clientPort:1,protocol:'wss'}}, resolve: { alias:")
  await f.put('vite.config.mjs', source)
  const planned = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, selector: f.input.plan.selector, scope: f.input.plan.scope })
  assert.ok(planned.kind === 'plan')
  f.input.plan = planned.plan
  running = await vueViteAdapter.start(f.input)
  const origin = new URL(running.url).origin
  assert.deepEqual(await upgrade(origin, '/api/socket?private=DO_NOT_REPORT_UPGRADE_QUERY', { Origin: origin }), { status: 403, upgraded: false })
  await assert.rejects(access(marker), { code: 'ENOENT' })
  const rejected: Record<string, string>[] = [
    { Origin: 'http://other.invalid', 'Sec-WebSocket-Protocol': 'vite-hmr' },
    { Origin: origin },
    { Origin: origin, 'Sec-WebSocket-Protocol': 'other-protocol' },
    { 'Sec-WebSocket-Protocol': 'vite-hmr' },
    { Host: 'foreign.invalid', Origin: 'http://foreign.invalid', 'Sec-WebSocket-Protocol': 'vite-hmr' },
  ]
  for (const headers of rejected) assert.deepEqual(await upgrade(origin, VITE_HMR_PATH, headers), { status: 403, upgraded: false })
  assert.deepEqual(await upgrade(origin, '/project-hmr', { Origin: origin, 'Sec-WebSocket-Protocol': 'vite-hmr' }), { status: 403, upgraded: false })
  assert.deepEqual(await upgrade(origin, VITE_HMR_PATH, { Origin: origin, 'Sec-WebSocket-Protocol': 'vite-hmr' }), { status: 101, upgraded: true })
  const client = await fetch(new URL('/@vite/client', origin)).then(response => response.text())
  assert.ok(client.includes(VITE_HMR_PATH))
  assert.ok(!client.includes('different.invalid'))
  assert.ok(f.events.some(value => value.type === 'diagnostic' && value.diagnostic.code === 'blocked_request'))
  assert.ok(!JSON.stringify(f.events).includes('DO_NOT_REPORT_UPGRADE_QUERY'))
})

test('explicitly disabled HMR does not admit an upgrade on its reserved path', options, async t => {
  if (!modules) throw new Error('Explicit existing toolchain required')
  const f = await createVueViteFixture(modules)
  let running: RunningHandle | undefined
  t.after(async () => { if (running) assert.deepEqual(await running.stop(), { residual: [] }); await f.cleanup() })
  const source = await readFile(join(f.appRoot, 'vite.config.mjs'), 'utf8')
  await f.put('vite.config.mjs', source.replace('resolve: { alias:', 'server:{hmr:false}, resolve: { alias:'))
  const planned = await vueViteAdapter.plan(f.input, { projectId: f.input.plan.projectId, targetId: f.input.plan.targetId, selector: f.input.plan.selector, scope: f.input.plan.scope })
  assert.ok(planned.kind === 'plan')
  f.input.plan = planned.plan
  running = await vueViteAdapter.start(f.input)
  const origin = new URL(running.url).origin
  assert.deepEqual(await upgrade(origin, VITE_HMR_PATH, { Origin: origin, 'Sec-WebSocket-Protocol': 'vite-hmr' }), { status: 403, upgraded: false })
})

test('the native Upgrade API is only assumed on the checked Node 24 line', () => {
  for (const version of ['22.18.0', '24.8.0', '24.9.0-rc.1', '25.0.0', 'invalid']) assert.equal(hasUpgradeGate(version), false)
  for (const version of ['24.9.0', '24.13.1']) assert.equal(hasUpgradeGate(version), true)
})
