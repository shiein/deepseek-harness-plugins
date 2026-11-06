/** Cookie/Storage 运行入口（方案 §9.2、§14）：独立样本进程，两个端口登记账本；只持久化已过滤的样本观察。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createFileLedger, readProcessStartTime } from '../../src/runner/ledger.ts'
import { startStorageProbe } from './phase0-storage-server.mjs'

const output = process.argv[2]
if (!output || !isAbsolute(output)) throw new Error('Absolute output directory is required')
await mkdir(output, { recursive: true })
const ledger = createFileLedger(output)
const owner = { previewId: 'phase0-storage', ownerSessionId: 'phase0-manual-probe', workspaceRoot: output }
const entries = []
const record = { pid: process.pid, startedAt: new Date().toISOString(), observations: [] }
let writes = Promise.resolve()
function save() { writes = writes.then(() => writeFile(join(output, 'storage-observations.json'), JSON.stringify(record, null, 2))); return writes }
let probe, closing
async function close() {
  if (closing) return closing
  closing = (async () => {
    await probe?.close()
    for (const entry of entries) await ledger.release(entry.id)
    record.cleaned = true
    await save()
  })()
  return closing
}
try {
  record.startTime = await readProcessStartTime(process.pid)
  if (!record.startTime) throw new Error('Probe process identity unavailable')
  entries.push(await ledger.record({ ...owner, resource: { kind: 'process', pid: process.pid, startTime: record.startTime, command: 'phase0-storage' } }))
  probe = await startStorageProbe((value) => {
    record.observations.push(value)
    void save().catch((error) => { console.error('Storage evidence write failed:', error.message); process.exitCode = 1 })
  })
  for (const origin of [probe.origin, probe.otherOrigin]) entries.push(await ledger.record({ ...owner, resource: { kind: 'port', port: Number(new URL(origin).port), pid: process.pid } }))
  Object.assign(record, { runId: probe.runId, origin: probe.origin, aliasOrigin: probe.aliasOrigin, otherOrigin: probe.otherOrigin, base: probe.base })
  await save()
  console.log(JSON.stringify({ ...record, observations: undefined }))
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void close().catch((error) => { console.error('Storage cleanup failed:', error.message); process.exitCode = 1 }) })
} catch (error) { record.error = String(error); await close(); throw error }
