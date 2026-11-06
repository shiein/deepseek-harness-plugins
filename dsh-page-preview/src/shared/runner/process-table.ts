/**
 * OS 进程表读取与按身份发信号（方案 §9.2）。
 * 进程归属核对只依据 PID/PPID/PGID 与启动时间，不按进程名或命令行匹配。
 * macOS 用 /bin/ps（已实测）；Linux 用 /proc/<pid>/stat（procfs.ts，合成树单测，
 * 真实 Linux 端到端验收仍是待办）；其余平台返回 unsupported，不把未知归属当成不存在。
 * 已终止待父进程回收的进程（Z/X，zombie）不进表：不占用资源、无法被信号终止，
 * 把它的 pid 当成残留成员只会产生误报（例如 SIGKILL 后 reap 前的短暂窗口）。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireSupportedPlatform } from './port-ownership.ts'
import { procProcessTable } from './procfs.ts'

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
