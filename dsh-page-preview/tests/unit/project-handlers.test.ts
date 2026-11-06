/** 授权前零执行及实际 Node handler 模块（方案 §7.2、§8、§13、§15.3）；仅可丢弃源码、受管子进程和合成复核。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadProjectHandlers } from '../../src/scenario/handlers.ts'
import { RunnerSessionError } from '../../src/shared/errors.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'
import type { ManagedProcess } from '../../src/runner/process-tree.ts'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { findListeningPids } from '../../src/runner/port-ownership.ts'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-handler-')))
  const app = join(root, 'app')
  await mkdir(app)
  const marker = join(root, 'evaluated')
  const put = async (path: string, source: string) => { const file = join(app, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, source) }
  await put('package.json', '{"type":"module"}')
  const ledger = createFileLedger(join(root, 'ledger'))
  const processes: ManagedProcess[] = []
  t.after(async () => {
    for (const process of processes) assert.deepEqual(await process.stop(), [])
    for (const entry of await ledger.listByPreview('handler-test')) {
      assert.equal(entry.resource.kind, 'port')
      if (entry.resource.kind === 'port') { assert.deepEqual(await findListeningPids(entry.resource.port), []); await ledger.release(entry.id) }
    }
    await rm(root, { recursive: true, force: true })
  })
  const start = async (file: string) => {
    const process = await spawnManaged({ executable: globalThis.process.execPath, args: [fileURLToPath(new URL('../fixtures/scenario/handler-loader.ts', import.meta.url)), app, file], cwd: app, env: {}, ipc: true }, ledger, { workspaceRoot: root, previewId: 'handler-test', ownerSessionId: 'own-handler-test' })
    processes.push(process)
    for (const output of [process.stdout, process.stderr]) void (async () => { for await (const _chunk of output) { /* Project output is not a protocol or diagnostic. */ } })()
    const message = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('Handler fixture did not answer')) }, 3000)
      const off = process.ipc!.onMessage(value => { clearTimeout(timer); resolve(value) })
      void process.exited.then(() => { clearTimeout(timer); off(); reject(new Error('Handler fixture exited')) }, reject)
    })
    return { process, message }
  }
  return { root, app, marker, put, ledger, start }
}
const hasCode = (code: string) => (error: unknown) => error instanceof RunnerSessionError && error.diagnostic.code === code

test('missing/revoked execution verification and cancellation never import the handler module', async t => {
  const f = await fixture(t)
  await f.put('handlers.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(f.marker)}, 'IMPORTED'); export default []`)
  await assert.rejects(loadProjectHandlers(f.app, 'handlers.mjs'), hasCode('config_changed_needs_approval'))
  await assert.rejects(loadProjectHandlers(f.app, 'handlers.mjs', { async verifyExecution() { throw new Error('PRIVATE_REJECTION') } }), hasCode('config_changed_needs_approval'))
  const known = new RunnerSessionError({ code: 'config_invalid', phase: 'config', message: 'Current configuration changed' })
  await assert.rejects(loadProjectHandlers(f.app, 'handlers.mjs', { async verifyExecution() { throw known } }), error => error === known)
  const abort = new AbortController()
  await assert.rejects(loadProjectHandlers(f.app, 'handlers.mjs', { signal: abort.signal, async verifyExecution() { abort.abort(new Error('OWN_CANCEL')) } }), /OWN_CANCEL/)
  await assert.rejects(access(f.marker), { code: 'ENOENT' })
})

test('handler module paths reject outside sources, environment aliases and unsupported files before execution verification', async t => {
  const f = await fixture(t)
  let calls = 0
  const options = { async verifyExecution() { calls++ } }
  await writeFile(join(f.root, '.env.private'), 'OWN_PRIVATE_FIXTURE')
  await symlink(join(f.root, '.env.private'), join(f.app, 'alias.mjs'))
  await f.put('.env', 'OWN_PRIVATE_FIXTURE')
  await f.put('not-handler.json', '{}')
  for (const file of ['../.env.private', '.env', 'alias.mjs', 'not-handler.json', 'missing.js']) await assert.rejects(loadProjectHandlers(f.app, file, options), hasCode('config_invalid'))
  assert.equal(calls, 0)
})

test('approved JS/TS/CJS handler arrays execute only in owned Node workers and own their request/store semantics',
  { skip: !['darwin', 'linux'].includes(process.platform), timeout: 15000 }, async t => {
  const f = await fixture(t)
  for (const extension of ['mjs', 'ts', 'cjs']) {
    const action = `(request${extension === 'ts' ? ': {path: string; method: string; body?: unknown}' : ''}, store${extension === 'ts' ? ': {set(key: string, value: unknown): void; get(key: string): unknown; reset(): void}' : ''}) => {
      if (request.path !== '/api/value') return undefined
      if (request.method === 'POST') store.set('value', request.body)
      if (request.method === 'DELETE') store.reset()
      return {status: 200, body: {pid: process.pid, value: store.get('value') ?? null}}
    }`
    const prelude = extension === 'cjs' ? `const {writeFileSync} = require('node:fs');` : `import {writeFileSync} from 'node:fs';`
    await f.put('handlers.' + extension, prelude + `writeFileSync(${JSON.stringify(f.marker)}, String(process.pid));` + (extension === 'cjs' ? 'module.exports = [' : 'export default [') + action + ']')
    const { process, message } = await f.start('handlers.' + extension)
    assert.ok(message && typeof message === 'object' && 'type' in message && message.type === 'ready' && 'origin' in message && typeof message.origin === 'string' && 'pid' in message && message.pid === process.pid && 'verifications' in message && message.verifications === 1)
    assert.equal(Number(await readFile(f.marker, 'utf8')), process.pid)
    assert.notEqual(process.pid, globalThis.process.pid)
    const port = Number(new URL(message.origin).port)
    assert.deepEqual(await findListeningPids(port), [process.pid])
    const entry = await f.ledger.record({ workspaceRoot: f.root, previewId: 'handler-test', ownerSessionId: 'own-handler-test', resource: { kind: 'port', pid: process.pid, port } })
    assert.deepEqual(await (await fetch(message.origin + '/api/value', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":42}' })).json(), { pid: process.pid, value: { value: 42 } })
    assert.deepEqual(await (await fetch(message.origin + '/api/value')).json(), { pid: process.pid, value: { value: 42 } })
    assert.deepEqual(await (await fetch(message.origin + '/api/value', { method: 'DELETE' })).json(), { pid: process.pid, value: null })
    assert.deepEqual(await process.stop(), [])
    assert.equal(await readProcessStartTime(process.pid), undefined)
    assert.deepEqual(await findListeningPids(port), [])
    await f.ledger.release(entry.id)
  }
})

test('project evaluation and invalid exports fail visibly without raw project values or alternative exports',
  { skip: !['darwin', 'linux'].includes(process.platform), timeout: 15000 }, async t => {
  const f = await fixture(t)
  for (const [source, code] of [
    ['throw new Error("PRIVATE_HANDLER_EVALUATION"); export default []', 'runtime_error'],
    ['export const handlers = [() => ({status:200})]', 'config_invalid'],
    ['export default () => ({status:200})', 'config_invalid'],
    ['export default [null]', 'config_invalid'],
  ]) {
    await f.put('invalid.mjs', source!)
    const { process, message } = await f.start('invalid.mjs')
    assert.ok(message && typeof message === 'object' && 'type' in message && message.type === 'failed' && 'diagnostic' in message && message.diagnostic && typeof message.diagnostic === 'object' && 'code' in message.diagnostic && message.diagnostic.code === code)
    assert.ok(!JSON.stringify(message).includes('PRIVATE_HANDLER_EVALUATION'))
    assert.deepEqual(await process.stop(), [])
  }
})
