/** 托管执行器 IPC（方案 §6.5、§9.2）；真实自有 Node 子进程，协议与 stdout 分离、账本后订阅也保留启动消息。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createFileLedger } from '../../src/runner/ledger.ts'
import { spawnManaged } from '../../src/runner/process-tree.ts'

test('managed native IPC retains early bootstrap while ledger writes and never parses raw output as protocol',
  { skip: !['darwin', 'linux'].includes(process.platform) }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-managed-ipc-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ledger = createFileLedger(root)
  const boot = join(root, 'boot')
  const owner = { previewId: 'ipc-test', ownerSessionId: 'owner', workspaceRoot: root }
  const delayed = {
    ...ledger,
    async record(input: Parameters<typeof ledger.record>[0]) {
      const entry = await ledger.record(input)
      const deadline = Date.now() + 5000
      while (true) {
        try { await readFile(boot); break }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        if (Date.now() >= deadline) throw new Error('Own IPC fixture did not boot')
        await delay(10)
      }
      return entry
    },
  }
  const source = `const { writeFileSync } = require('node:fs'); process.on('message', message => process.send({ type: 'echo', value: message.value })); process.send({ type: 'boot' }); process.stdout.write('{"type":"fake-stdout"}'); writeFileSync(process.argv[1], 'booted')`
  const proc = await spawnManaged({ executable: process.execPath, args: ['-e', source, boot], cwd: root, env: {}, ipc: true }, delayed, owner)
  t.after(() => proc.stop(1000).then(() => {}))
  const output = (async () => { let text = ''; for await (const chunk of proc.stdout) text += chunk; return text })()
  const errors = (async () => { let text = ''; for await (const chunk of proc.stderr) text += chunk; return text })()
  assert.ok(proc.ipc)
  const messages: unknown[] = []
  let received!: (value: unknown) => void
  const echoed = new Promise<unknown>(resolve => { received = resolve })
  const off = proc.ipc.onMessage(message => { messages.push(message); if (messages.length === 2) received(message) })
  assert.deepEqual(messages, [{ type: 'boot' }])
  await proc.ipc.send({ type: 'request', value: 'private IPC payload' })
  assert.deepEqual(await echoed, { type: 'echo', value: 'private IPC payload' })
  assert.equal(messages.length, 2)
  off()
  assert.deepEqual(await proc.stop(1000), [])
  await proc.exited
  assert.equal(await output, '{"type":"fake-stdout"}')
  assert.equal(await errors, '')
  assert.deepEqual(await ledger.listByPreview(owner.previewId), [])
  await assert.rejects(proc.ipc.send({ type: 'late' }), /disconnected/)
})
