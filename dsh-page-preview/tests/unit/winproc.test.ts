/**
 * Windows 探针与组归属的合成单测（方案 §9.2）。只验证解析与判定逻辑（以 platform 参数模拟 win32），
 * 真实 Windows 端到端（PowerShell 输出、TerminateProcess、IPC 断开的优雅关闭）未验。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareStartTime, isLoopbackAddress, parseWinListeners, parseWinProcessTable,
} from '../../src/shared/runner/winproc.ts'
import { groupMembersOf, hasLiveParent, leadsGroup, signalGroup } from '../../src/shared/runner/process-table.ts'
import { windowsParents } from '../../src/shared/runner/port-ownership.ts'
import {
  UnsafeWindowsArgumentError, launchCommand, nodeExecutableName, platformBaseEnv, withPlatformBase,
} from '../../src/shared/runner/platform-env.ts'

// FILETIME 十进制串：数值越大越晚创建。
const T = (n: number) => String(133_000_000_000_000_000n + BigInt(n))
const row = (pid: number, ppid: number, start: number) => `${pid}\t${ppid}\t${T(start)}`

test('parses the CIM process table and refuses unexpected lines', () => {
  const table = parseWinProcessTable([row(4, 0, 1), row(900, 4, 10), '', row(1200, 900, 20)].join('\r\n') + '\r\n')
  assert.deepEqual([...table.keys()], [4, 900, 1200])
  assert.deepEqual(table.get(1200), { pid: 1200, ppid: 900, pgid: 1200, startTime: T(20) })
  assert.throws(() => parseWinProcessTable('Get-CimInstance : Access denied'), /Unexpected Windows process table/)
  assert.equal(parseWinProcessTable('').size, 0)
})

test('parses listeners and keeps only loopback addresses as loopback', () => {
  const lines = ['127.0.0.1\t5173\t1200', '::1\t5174\t1200', '0.0.0.0\t3000\t77', '::\t445\t4']
  const listeners = parseWinListeners(lines.join('\r\n'))
  assert.equal(listeners.length, 4)
  assert.deepEqual(listeners[0], { address: '127.0.0.1', port: 5173, pid: 1200 })
  assert.deepEqual(listeners.map(value => isLoopbackAddress(value.address)), [true, true, false, false])
  assert.throws(() => parseWinListeners('LISTENING 127.0.0.1:80'), /Unexpected Windows TCP listener/)
})

test('start times compare numerically, not as text of different lengths', () => {
  assert.ok(compareStartTime('99', '100') < 0)
  assert.equal(compareStartTime(T(5), T(5)), 0)
  assert.ok(compareStartTime(T(6), T(5)) > 0)
})

test('a Windows group is the leader and its creation-ordered descendants', () => {
  const table = parseWinProcessTable([
    row(4, 0, 1),
    row(500, 4, 5), // the Runner
    row(1000, 500, 10), // leader
    row(1100, 1000, 11), // child
    row(1101, 1100, 12), // grandchild
    row(2000, 500, 13), // sibling of the leader: not a member
  ].join('\n'))
  const group = { pgid: 1000, leaderStart: T(10) }
  assert.deepEqual(groupMembersOf(table, group, 'win32').map(value => value.pid).sort(), [1000, 1100, 1101])
  assert.ok(leadsGroup(table.get(1000)!, 1000, 'win32'))
  assert.ok(!leadsGroup(table.get(1100)!, 1000, 'win32'))
})

test('after the leader exits its orphans still belong to the group', () => {
  const table = parseWinProcessTable([row(500, 4, 5), row(1100, 1000, 11), row(1101, 1100, 12)].join('\n'))
  const members = groupMembersOf(table, { pgid: 1000, leaderStart: T(10) }, 'win32')
  assert.deepEqual(members.map(value => value.pid).sort(), [1100, 1101])
})

test('a reused leader PID adopts neither the new process nor its children', () => {
  const table = parseWinProcessTable([
    row(1000, 4, 50), // PID 1000 reused by a later, unrelated process
    row(1100, 1000, 11), // our orphan: created before the reuse
    row(1300, 1000, 60), // child of the unrelated process
  ].join('\n'))
  const members = groupMembersOf(table, { pgid: 1000, leaderStart: T(10) }, 'win32')
  assert.deepEqual(members.map(value => value.pid), [1100])
})

test('a process older than the leader is never a member', () => {
  const table = parseWinProcessTable([row(1000, 4, 10), row(800, 1000, 3)].join('\n'))
  const members = groupMembersOf(table, { pgid: 1000, leaderStart: T(10) }, 'win32')
  assert.deepEqual(members.map(value => value.pid), [1000])
})

test('POSIX groups stay keyed by pgid', () => {
  const table = new Map([
    [10, { pid: 10, ppid: 1, pgid: 10, startTime: 'a' }],
    [11, { pid: 11, ppid: 10, pgid: 10, startTime: 'b' }],
    [12, { pid: 12, ppid: 10, pgid: 12, startTime: 'c' }],
  ])
  assert.deepEqual(groupMembersOf(table, { pgid: 10 }, 'darwin').map(value => value.pid), [10, 11])
})

test('Windows orphans are detected by creation order, not by PID 1', () => {
  const rows = [row(500, 4, 5), row(1000, 500, 10), row(1200, 999, 20), row(999, 4, 30)]
  const table = parseWinProcessTable(rows.join('\n'))
  assert.ok(hasLiveParent(table.get(1000)!, table, 'win32'))
  assert.ok(!hasLiveParent(table.get(1200)!, table, 'win32'), 'PPID 999 was reused after 1200 was created')
  const parents = windowsParents(table)
  assert.equal(parents.get(1000), 500)
  assert.equal(parents.get(1200), 0)
})

test('signalGroup on Windows terminates members one by one, newest first', () => {
  const sent: Array<[number, string]> = []
  const original = process.kill
  process.kill = ((pid: number, signal: string) => { sent.push([pid, signal]); return true }) as typeof process.kill
  try {
    const table = parseWinProcessTable([row(1000, 500, 10), row(1100, 1000, 11), row(1101, 1100, 12)].join('\n'))
    const group = { pgid: 1000, leaderStart: T(10) }
    signalGroup(group, groupMembersOf(table, group, 'win32'), 'SIGTERM', 'win32')
    assert.deepEqual(sent, [[1101, 'SIGTERM'], [1100, 'SIGTERM'], [1000, 'SIGTERM']])
    sent.length = 0
    signalGroup({ pgid: 1000 }, [], 'SIGTERM', 'darwin')
    assert.deepEqual(sent, [[-1000, 'SIGTERM']])
  } finally { process.kill = original }
})

test('the Windows environment base carries only OS locations', () => {
  const source = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\T', PATH: 'C:\\bin', API_TOKEN: 'secret', ComSpec: '' }
  assert.deepEqual(platformBaseEnv('win32', source), { SystemRoot: 'C:\\Windows', TEMP: 'C:\\T' })
  assert.deepEqual(platformBaseEnv('darwin', source), {})
  assert.deepEqual(withPlatformBase({ PATH: 'X' }, 'darwin'), { PATH: 'X' })
  assert.equal(nodeExecutableName('win32'), 'node.exe')
  assert.equal(nodeExecutableName('linux'), 'node')
})

test('Windows .cmd scripts start through cmd.exe with quoted arguments', () => {
  const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  assert.deepEqual(launchCommand('C:\\node\\npm.cmd', ['run', 'dev', '--', '--port', '5173'], 'win32', env), {
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\node\\npm.cmd run dev -- --port 5173"'],
    windowsVerbatimArguments: true,
  })
  const spaced = launchCommand('C:\\Program Files\\nodejs\\npm.CMD', ['run', 'a&b'], 'win32', env)
  assert.equal(spaced.args[3], '""C:\\Program Files\\nodejs\\npm.CMD" run "a&b""')
  assert.throws(() => launchCommand('npm.cmd', ['%PATH%'], 'win32', env), UnsafeWindowsArgumentError)
  assert.throws(() => launchCommand('npm.cmd', ['a"b'], 'win32', env), UnsafeWindowsArgumentError)
  const exe = 'C:\\node\\node.exe'
  assert.deepEqual(launchCommand(exe, ['x'], 'win32', env), { executable: exe, args: ['x'] })
  const posix = '/usr/bin/npm.cmd'
  assert.deepEqual(launchCommand(posix, ['x'], 'darwin', env), { executable: posix, args: ['x'] })
})
