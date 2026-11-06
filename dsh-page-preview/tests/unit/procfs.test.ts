/** Linux /proc 探针的合成树单测（方案 §9.2、P1-2）；只验证解析器，真实 Linux 端到端仍是待办。 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseProcNetTcp, parseProcStat, procProcessStartTime, procProcessTable, procSocketOwners, procTcpListeners, procTcp4Loopback, procTcp6Loopback } from '../../src/shared/runner/procfs.ts'

/** 合成 stat 行：state(3) 起依次 ppid pgrp …… 字段 22 为 starttime。 */
function statLine(pid: number, ppid: number, pgid: number, starttime: number, comm = 'worker', state = 'S'): string {
  const rest = [state, String(ppid), String(pgid), '0', '0', '0', '0', '0', '0', '0',
    '0', '0', '0', '0', '0', '0', '0', '0', '0', String(starttime), '100', '0']
  return pid + ' (' + comm + ') ' + rest.join(' ') + '\n'
}

function tcpLine(local: string, remote: string, state: string, inode: number): string {
  return '  1: ' + local + ' ' + remote + ' ' + state + ' 00000000:00000000 00:00000000 00000000  1000        0 ' + inode + ' 1 0000000000000000 100 0 0 10 0'
}

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'

test('parseProcStat reads ppid/pgid/starttime even with spaces and parens in comm', () => {
  const identity = parseProcStat(statLine(4242, 1000, 4200, 987654321, 'node (worker) x)'))
  assert.deepEqual(identity, { pid: 4242, ppid: 1000, pgid: 4200, startTime: '987654321', state: 'S' })
  assert.throws(() => parseProcStat('garbage'), /stat format/)
})

test('parseProcNetTcp keeps only LISTEN rows and classifies loopback', () => {
  const table = TCP_HEADER + [
    tcpLine('0100007F:1F90', '00000000:0000', '0A', 12345), // 127.0.0.1:8080 LISTEN
    tcpLine('00000000:0050', '00000000:0000', '0A', 12346), // 0.0.0.0:80 LISTEN
    tcpLine('7F000001:1F91', '7F000001:9C40', '06', 12347), // TIME_WAIT，忽略
    tcpLine('0200007F:0000', '00000000:0000', '0A', 12348), // 127.0.0.2:0 非法端口，丢弃
  ].join('\n') + '\n'
  assert.deepEqual(parseProcNetTcp(table, procTcp4Loopback), [
    { port: 8080, loopback: true, inode: 12345 },
    { port: 80, loopback: false, inode: 12346 },
  ])
  assert.ok(procTcp4Loopback('0100007F') && procTcp4Loopback('0302017F'))
  assert.ok(!procTcp4Loopback('00000000'))
  assert.ok(procTcp6Loopback('00000000000000000000000001000000'))
  assert.ok(procTcp6Loopback('00000000000000000000FFFF0100007F'))
  assert.ok(!procTcp6Loopback('00000000000000000000000000000000'))
})

test('procfs readers traverse a synthetic /proc tree: table, start time, listener inodes and socket owners', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-procfs-'))
  t.after(async () => { await chmod(join(root, '9999'), 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }) })
  const put = async (pid: number, stat: string, fds: Record<string, string>) => {
    const dir = join(root, String(pid))
    await mkdir(join(dir, 'fd'), { recursive: true })
    await writeFile(join(dir, 'stat'), stat)
    for (const [fd, target] of Object.entries(fds)) await symlink(target, join(dir, 'fd', fd))
  }
  await put(4000, statLine(4000, 1, 4000, 111111), { 3: 'socket:[22001]', 4: 'anon_inode:[eventpoll]' })
  await put(4001, statLine(4001, 4000, 4000, 222222), { 5: 'socket:[22002]' })
  await put(4002, statLine(4002, 1, 4002, 333333), { 3: 'socket:[22002]' }) // 同 socket 多进程持有（fork 继承）
  await mkdir(join(root, '9999', 'fd'), { recursive: true })
  await writeFile(join(root, '9999', 'stat'), statLine(9999, 1, 9999, 444444))
  await chmod(join(root, '9999'), 0) // 他人进程：fd 目录 EACCES 按不可核对跳过
  await mkdir(join(root, 'net'), { recursive: true })
  await writeFile(join(root, 'net', 'tcp'), TCP_HEADER + [
    tcpLine('0100007F:1F90', '00000000:0000', '0A', 22001), // 127.0.0.1:8080
    tcpLine('00000000:0050', '00000000:0000', '0A', 22099), // 0.0.0.0:80 非环回
  ].join('\n') + '\n')
  await writeFile(join(root, 'net', 'tcp6'), TCP_HEADER + tcpLine('00000000000000000000000001000000:1F91', '00000000000000000000000000000000:0000', '0A', 22002) + '\n')

  const table = await procProcessTable(root)
  assert.deepEqual(table.get(4001), { pid: 4001, ppid: 4000, pgid: 4000, startTime: '222222', state: 'S' })
  assert.equal(await procProcessStartTime(4000, root), '111111')
  assert.equal(await procProcessStartTime(4242, root), undefined)

  const listeners = await procTcpListeners(root)
  assert.deepEqual(listeners.sort((a, b) => a.port - b.port), [
    { port: 80, loopback: false, inode: 22099 },
    { port: 8080, loopback: true, inode: 22001 },
    { port: 8081, loopback: true, inode: 22002 },
  ])

  const owners = await procSocketOwners(root)
  assert.deepEqual(owners.get(22001), new Set([4000]))
  assert.deepEqual(owners.get(22002), new Set([4001, 4002]), 'Socket inherited across processes reports all holders')
  assert.ok(!owners.has(9999), 'Unreadable fd directories must not be claimed as owners')
})

test('zombie processes (Z/X) are absent from the table and start-time reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-procfs-z-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [pid, state] of [[5000, 'Z'], [5001, 'X'], [5002, 'S']] as const) {
    await mkdir(join(root, String(pid), 'fd'), { recursive: true })
    await writeFile(join(root, String(pid), 'stat'), statLine(pid, 1, 5000, 777777 + pid, 'worker', state))
  }
  const table = await procProcessTable(root)
  assert.ok(!table.has(5000) && !table.has(5001), 'Dead processes must not count as live group members')
  assert.ok(table.has(5002))
  assert.equal(await procProcessStartTime(5000, root), undefined)
  assert.equal(await procProcessStartTime(5001, root), undefined)
  assert.equal(await procProcessStartTime(5002, root), String(777777 + 5002))
})
