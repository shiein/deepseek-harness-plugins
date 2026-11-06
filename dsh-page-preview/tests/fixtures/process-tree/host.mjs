/* Phase 0 的可丢弃 Host：记录服务 PID/启动时间后才通知父测试进程。 */
import { fork } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createFileLedger, readProcessStartTime } from '../../../src/runner/ledger.ts'
const child = fork(new URL('./server.mjs', import.meta.url), [], {
  detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  env: {},
})
const [address] = await once(child, 'message')
const startTime = await readProcessStartTime(child.pid)
const childStartTime = await readProcessStartTime(address.childPid)
if (!startTime || !childStartTime) throw new Error('Disposable server exited before identity capture')
const entry = { pid: child.pid, pgid: child.pid, startTime, port: address.port,
  childPid: address.childPid, childPort: address.childPort, childStartTime }
await writeFile(process.argv[2], JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
const ledger = createFileLedger(process.argv[3])
const owner = { previewId: 'phase0-process', ownerSessionId: 'phase0-host', workspaceRoot: process.argv[3] }
await ledger.record({ ...owner, resource: { kind: 'process', pid: entry.pid, pgid: entry.pgid, startTime, command: 'phase0 disposable server' } })
await ledger.record({ ...owner, resource: { kind: 'process', pid: entry.childPid, startTime: childStartTime, command: 'phase0 disposable descendant' } })
await ledger.record({ ...owner, resource: { kind: 'port', port: entry.port, pid: entry.pid } })
await ledger.record({ ...owner, resource: { kind: 'port', port: entry.childPort, pid: entry.childPid } })
process.send({ kind: 'recorded' })
