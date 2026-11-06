/** macOS/Linux 真实进程/端口探针（方案 §9.2、§14、§15.2），不接入业务服务。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { readProcessStartTime } from '../../src/runner/ledger.ts'
import { findFreeLoopbackPort, findListeningPids, findOwnedListeningPorts, isDescendantOf } from '../../src/runner/port-ownership.ts'

test('free port helper releases its suggestion for the actual listener', async () => {
  const port = await findFreeLoopbackPort()
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
})

test('platform probe verifies PID identity, descendants and actual changed port',
  { skip: !['darwin', 'linux'].includes(process.platform) }, async (t) => {
  const occupied = createServer()
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => occupied.close((err) => err ? reject(err) : resolve())))
  const occupiedPort = (occupied.address() as AddressInfo).port
  // 包装进程模拟 npm run；后代忽略建议端口并让 OS 分配真实端口。
  const script = `
    const {fork}=require('node:child_process');
    const child=fork('-e', ["const net=require('node:net'); const s=net.createServer(); s.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:s.address().port}));"], {execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
    child.on('message',m=>process.send(m));
    process.on('SIGTERM',()=>{child.kill();child.on('exit',()=>process.exit(0))});
  `
  const wrapper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = once(wrapper, 'exit')
  t.after(async () => { wrapper.kill(); await exited })
  const [raw] = await once(wrapper, 'message', { signal: AbortSignal.timeout(5000) })
  assert.ok(typeof raw === 'object' && raw !== null && 'pid' in raw && 'port' in raw)
  const pid = Number(raw.pid)
  const port = Number(raw.port)
  assert.ok(wrapper.pid)
  assert.notEqual(port, occupiedPort)
  const start = await readProcessStartTime(pid)
  assert.ok(start)
  assert.equal(await readProcessStartTime(pid), start)
  assert.deepEqual(await findListeningPids(port), [pid])
  assert.ok((await findListeningPids(occupiedPort)).includes(process.pid))
  assert.equal(await isDescendantOf(pid, wrapper.pid), true)
  assert.equal(await isDescendantOf(pid, pid), true)
  assert.equal(await isDescendantOf(process.pid, wrapper.pid), false)
  assert.deepEqual(await findOwnedListeningPorts(wrapper.pid), [port])
  wrapper.kill()
  await exited
  assert.equal(await readProcessStartTime(pid), undefined)
  assert.deepEqual(await findListeningPids(port), [])
})

test('ownership queries reject invalid pid and port values', async () => {
  await assert.rejects(readProcessStartTime(0), RangeError)
  await assert.rejects(findListeningPids(65536), RangeError)
  await assert.rejects(isDescendantOf(-1, process.pid), RangeError)
})
