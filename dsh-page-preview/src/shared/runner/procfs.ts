/**
 * Linux /proc 只读探针（方案 §9.2、§6.8）：进程表/启动时间/监听端口归属。
 * 解析函数接受可注入的 procRoot，合成 /proc 树上有单测；
 * static/project-command 生命周期已在 Docker node:24（Linux）真实验收（R2-5），其余平台仍不宣称支持。
 */

import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessIdentity } from './process-table.ts'

/**
 * 解析 /proc/<pid>/stat。comm 可含空格与括号，必须从最后一个 ) 之后切字段；
 * starttime（第 22 字段，自启动的 jiffies）作为防 PID 复用的不透明身份串，只需稳定可比较。
 */
export function parseProcStat(raw: string): ProcessIdentity {
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 1 || close <= open) throw new Error('Unexpected /proc stat format')
  const pid = Number(raw.slice(0, open).trim())
  // 切分后 fields[0]=state（字段 3），因此 starttime（字段 22）位于索引 19。
  const fields = raw.slice(close + 1).trim().split(/\s+/)
  const state = fields[0]
  const ppid = Number(fields[1])
  const pgid = Number(fields[2])
  const startTime = fields[19]
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)
      || startTime === undefined || !/^\d+$/.test(startTime) || state?.length !== 1) {
    throw new Error('Unexpected /proc stat field values')
  }
  return { pid, ppid, pgid, startTime, state }
}

/** 遍历 /proc 数字目录生成进程表；读取期间退出的进程按竞态跳过，已终止未回收的（Z/X）不算存活成员。 */
export async function procProcessTable(procRoot = '/proc'): Promise<Map<number, ProcessIdentity>> {
  const table = new Map<number, ProcessIdentity>()
  for (const name of await readdir(procRoot)) {
    if (!/^\d+$/.test(name)) continue
    let raw: string
    try {
      raw = await readFile(join(procRoot, name, 'stat'), 'utf8')
    } catch (error) {
      // 退出竞态或 hidepid/他人进程不可读：该 PID 无法被证明属于我们的进程树，如实缺席。
      if (isNotFound(error) || isDenied(error)) continue
      throw error
    }
    const identity = parseProcStat(raw)
    // 已终止待回收（Z/X）不占用资源也不能被信号终止，不算存活成员（与 process-table.ts 同规则）。
    if (identity.state === 'Z' || identity.state === 'X') continue
    table.set(Number(name), identity)
  }
  return table
}

/** 读取单个进程启动时间；进程不存在或已终止未回收返回 undefined，其余错误如实抛出。 */
export async function procProcessStartTime(pid: number, procRoot = '/proc'): Promise<string | undefined> {
  try {
    const identity = parseProcStat(await readFile(join(procRoot, String(pid), 'stat'), 'utf8'))
    return identity.state === 'Z' || identity.state === 'X' ? undefined : identity.startTime
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

export interface ProcTcpListener {
  port: number
  /** local_address 是 loopback（127.0.0.0/8 或 ::1/::ffff:127.0.0.1）；通配与非环回地址不接受为归属证据。 */
  loopback: boolean
  inode: number
}

/**
 * 解析 /proc/net/tcp{,6}：只保留 st=0A（LISTEN）行，local_address 字段为 `<hexaddr>:<hexport>`，
 * inode 位于第 10 列。loopback 判定由调用方按地址族提供。
 */
export function parseProcNetTcp(raw: string, isLoopback: (hexAddress: string) => boolean): ProcTcpListener[] {
  const listeners: ProcTcpListener[] = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (index === 0 || !line.trim()) continue
    const fields = line.trim().split(/\s+/)
    const local = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(fields[1] ?? '')
    if (!local) throw new Error('Unexpected /proc/net/tcp format')
    if (fields[3] !== '0A') continue // 只保留 LISTEN；其他状态行是正常内容，不是格式错误。
    const inode = Number(fields[9])
    if (!Number.isSafeInteger(inode) || inode <= 0) throw new Error('Unexpected /proc/net/tcp inode')
    const port = parseInt(local[2]!, 16)
    if (port >= 1 && port <= 65535) listeners.push({ port, loopback: isLoopback(local[1]!.toUpperCase()), inode })
  }
  return listeners
}

/** 127.0.0.0/8：local_address 按小端 u32 打印，末两字符固定为 7F。 */
export const procTcp4Loopback = (hexAddress: string): boolean => /^[0-9A-F]{6}7F$/.test(hexAddress)

/** ::1 为 `00000000000000000000000001000000`；IPv4-mapped ::ffff:127.x.y.z 为 `0{16}0000FFFF` + 小端 7F。 */
export const procTcp6Loopback = (hexAddress: string): boolean => hexAddress === '00000000000000000000000001000000' || /^0{16}0000FFFF[0-9A-F]{6}7F$/.test(hexAddress)

/** tcp6 文件在禁用 IPv6 的内核上可能不存在，缺失时只返回 tcp 结果。 */
export async function procTcpListeners(procRoot = '/proc'): Promise<ProcTcpListener[]> {
  const listeners: ProcTcpListener[] = []
  try {
    listeners.push(...parseProcNetTcp(await readFile(join(procRoot, 'net', 'tcp'), 'utf8'), procTcp4Loopback))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  try {
    listeners.push(...parseProcNetTcp(await readFile(join(procRoot, 'net', 'tcp6'), 'utf8'), procTcp6Loopback))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  return listeners
}

/**
 * 把监听 socket 的 inode 反查到持有该 fd 的 PID（/proc/<pid>/fd → `socket:[inode]`）。
 * 其他用户的 fd 目录不可读时按身份不可核对跳过（它本来就不能被证明属于我们的进程树）；
 * ENOENT 是进程退出竞态；其余错误如实抛出，不静默降级。
 */
export async function procSocketOwners(procRoot = '/proc'): Promise<Map<number, Set<number>>> {
  const owners = new Map<number, Set<number>>()
  for (const name of await readdir(procRoot)) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    let fds: string[]
    try {
      fds = await readdir(join(procRoot, name, 'fd'))
    } catch (error) {
      if (isNotFound(error) || isDenied(error)) continue
      throw error
    }
    for (const fd of fds) {
      let target: string
      try {
        target = await readlink(join(procRoot, name, 'fd', fd))
      } catch (error) {
        if (isNotFound(error) || isDenied(error)) continue
        throw error
      }
      const socket = /^socket:\[(\d+)\]$/.exec(target)
      if (!socket) continue
      const inode = Number(socket[1])
      const set = owners.get(inode) ?? new Set<number>()
      if (!owners.has(inode)) owners.set(inode, set)
      set.add(pid)
    }
  }
  return owners
}

// ENOENT 是目录项消失；进程在 open 之后、read/readlink 之前退出时 Linux /proc 返回 ESRCH，同属退出竞态。
function isNotFound(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ESRCH'
}
function isDenied(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EACCES' }
