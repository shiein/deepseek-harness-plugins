/**
 * OS 进程表读取与按身份发信号（方案 §9.2）。
 * 进程归属核对只依据 PID/PPID/PGID 与启动时间，不按进程名或命令行匹配。
 * macOS 用 /bin/ps（已实测）；Linux 用 /proc/<pid>/stat（procfs.ts，合成树单测，
 * 真实 Linux 端到端验收仍是待办）；Windows 用 CIM Win32_Process（winproc.ts，合成输出单测，
 * 真实 Windows 未验）；其余平台返回 unsupported，不把未知归属当成不存在。
 *
 * 进程组：POSIX 用真实 pgid（detached 新进程组）。Windows 没有进程组，组归属按「组长的后代」判定，
 * 父子链的每一步都要求父进程早于子进程创建（Windows 不重挂孤儿，PPID 可能指向已退出或被复用的 PID）；
 * 组长退出后，仍记着组长 PID 且晚于组长创建的子进程仍算组员。中间进程已退出的孙进程无法再归属，
 * 与 POSIX 下 setsid 逃逸同样计为无法覆盖。
 * 已终止待父进程回收的进程（Z/X，zombie）不进表：不占用资源、无法被信号终止，
 * 把它的 pid 当成残留成员只会产生误报（例如 SIGKILL 后 reap 前的短暂窗口）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireSupportedPlatform } from './port-ownership.ts'
import { procProcessTable } from './procfs.ts'
import { compareStartTime, winProcessTable } from './winproc.ts'

const execFileAsync = promisify(execFile)

export interface ProcessIdentity {
  pid: number
  ppid: number
  pgid: number
  startTime: string
  /** macOS 取 ps STAT 首字符、Linux 取 stat 第 3 字段；'Z'/'X' 为已终止未回收。 */
  state?: string
}

/** 已终止待父进程回收的进程不占资源、也无法被信号杀死，不算存活成员。 */
export function isDeadProcess(process: ProcessIdentity): boolean {
  return process.state === 'Z' || process.state === 'X'
}

export { requireSupportedPlatform }

export async function processTable(): Promise<Map<number, ProcessIdentity>> {
  if (process.platform === 'linux') return procProcessTable()
  if (process.platform === 'win32') return winProcessTable()
  requireSupportedPlatform()
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    { env: { LC_ALL: 'C' } })
  const result = new Map<number, ProcessIdentity>()
  for (const line of stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) throw new Error('Unexpected process identity table output')
    const identity: ProcessIdentity = {
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      state: match[4]!.charAt(0), startTime: match[5]!,
    }
    if (isDeadProcess(identity)) continue
    result.set(identity.pid, identity)
  }
  return result
}

/** 只对明确给出 PID/进程组号的目标发信号；ESRCH 视为已退出，不视为成功终止证据。 */
export function signalPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
}

/** 托管进程组：组号（POSIX pgid，Windows 为组长 PID）与组长启动时间（Windows 判定后代时需要）。 */
export interface ProcessGroup {
  pgid: number
  leaderStart?: string
}

/** 进程表中属于该组的存活进程（含组长）。 */
export function groupMembersOf(
  table: Map<number, ProcessIdentity>,
  group: ProcessGroup,
  platform: NodeJS.Platform = process.platform,
): ProcessIdentity[] {
  if (platform !== 'win32') return [...table.values()].filter(member => member.pgid === group.pgid)
  return [...table.values()].filter(member => windowsGroupMember(member, group, table))
}

/** 该进程仍是自己组的组长（POSIX 核对 pgid；Windows 无组，组号即组长 PID）。 */
export function leadsGroup(identity: ProcessIdentity, pgid: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? identity.pid === pgid : identity.pgid === pgid
}

/**
 * 父进程仍存活且确是它的父进程。POSIX 孤儿被重挂到 PID 1；Windows 不重挂，PPID 指向的进程必须早于
 * 它创建，否则只是复用了已退出父进程的 PID。
 */
export function hasLiveParent(
  identity: ProcessIdentity,
  table: Map<number, ProcessIdentity>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const parent = table.get(identity.ppid)
  if (!parent) return false
  if (platform !== 'win32') return identity.ppid !== 1
  return compareStartTime(parent.startTime, identity.startTime) <= 0
}

/** 平台使用真实进程组；Windows 的组成员由后代关系推出，不存在「组外后代」。 */
export function usesProcessGroups(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * 向整组发信号。POSIX 发给 -pgid；Windows 逐个终止核对过的成员（Node 在 Windows 上的 SIGTERM/SIGKILL
 * 都是 TerminateProcess，没有优雅语义；优雅关闭走 IPC 断开，见 process-tree.ts），子进程先于父进程。
 */
export function signalGroup(
  group: ProcessGroup,
  members: ProcessIdentity[],
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') { signalPid(-group.pgid, signal); return }
  const ordered = [...members].sort((a, b) => compareStartTime(b.startTime, a.startTime))
  for (const member of ordered) signalPid(member.pid, signal)
}

function windowsGroupMember(member: ProcessIdentity, group: ProcessGroup, table: Map<number, ProcessIdentity>): boolean {
  const seen = new Set<number>()
  let current = member
  while (!seen.has(current.pid)) {
    seen.add(current.pid)
    if (current.pid === group.pgid) return group.leaderStart === undefined || current.startTime === group.leaderStart
    if (group.leaderStart !== undefined && compareStartTime(current.startTime, group.leaderStart) < 0) return false
    const parent = table.get(current.ppid)
    if (current.ppid === group.pgid) return windowsChildOfLeader(current, parent, group)
    if (!parent || compareStartTime(parent.startTime, current.startTime) > 0) return false
    current = parent
  }
  return false
}

/** `child` 记着组长 PID：组长已退出、仍是组长，或该 PID 已被晚于子进程创建的进程复用，都算组员。 */
function windowsChildOfLeader(child: ProcessIdentity, parent: ProcessIdentity | undefined, group: ProcessGroup): boolean {
  if (!parent) return true
  if (compareStartTime(parent.startTime, child.startTime) > 0) return true
  return group.leaderStart === undefined || parent.startTime === group.leaderStart
}
