/**
 * 共用端口归属核对（方案 §9.2）；Host 仅使用查询，不调用端口分配函数。
 * 分配端口与子进程实际绑定之间有竞态；许多 dev server 被占时静默换端口。
 * 以实际监听结果为准：能传严格端口参数时传（如 Vite --strictPort）；
 * 否则只接受归属核对通过的监听地址，失败返回 ownership_unverified。
 *
 * 平台实现：macOS 用 lsof/ps（已实测）；Linux 用 /proc/net/tcp* + /proc/<pid>/fd + /proc/<pid>/stat
 * （procfs.ts，解析器有合成树单测，真实 Linux 端到端验收仍是待办）；其余平台返回 unsupported。
 */

import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { promisify } from 'node:util'
import { DiagnosticCode, RunnerSessionError } from '../errors.ts'
import { procProcessTable, procSocketOwners, procTcpListeners } from './procfs.ts'

const execFileAsync = promisify(execFile)

/** 只用于建议端口，不作为归属证据；真正启动时仍须校验实际监听结果。 */
export async function findFreeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

/**
 * 查找监听该端口的 PID。
 * macOS 用 lsof；Linux 用 /proc/net/tcp* 的 inode 反查 /proc/<pid>/fd 持有者。
 */
export async function findListeningPids(port: number): Promise<number[]> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid TCP port')
  if (process.platform === 'linux') {
    const inodes = new Set((await procTcpListeners()).filter(value => value.port === port).map(value => value.inode))
    return [...(await procSocketOwners())].filter(([inode]) => inodes.has(inode)).flatMap(([, pids]) => [...pids])
  }
  const output = await queryListeners(['-iTCP:' + port, '-sTCP:LISTEN', '-Fp'])
  return [...new Set(output.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1))))]
}

/** pid 是否是 rootPid 的后代（含自身）；只读 OS 进程表，不按命令行匹配。 */
export async function isDescendantOf(pid: number, rootPid: number): Promise<boolean> {
  validatePid(pid)
  validatePid(rootPid)
  return descendant(pid, rootPid, await processParents())
}

/**
 * 在托管进程树中找出实际监听的 loopback 端口（用于 dev server 静默换端口的情况）。
 * 不接受监听所有网卡的地址；不依据日志里的 URL 猜测端口。
 */
export async function findOwnedListeningPorts(rootPid: number): Promise<number[]> {
  validatePid(rootPid)
  if (process.platform === 'linux') {
    const listeners = (await procTcpListeners()).filter(value => value.loopback)
    const owners = await procSocketOwners()
    const parents = await processParents()
    const ports = new Set<number>()
    for (const listener of listeners) {
      for (const pid of owners.get(listener.inode) ?? []) {
        if (descendant(pid, rootPid, parents)) ports.add(listener.port)
      }
    }
    return [...ports].sort((a, b) => a - b)
  }
  const output = await queryListeners(['-iTCP', '-sTCP:LISTEN', '-Fpn'])
  const parents = await processParents()
  const ports = new Set<number>()
  let pid = 0
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1))
    const address = /^n(?:127\.0\.0\.1|\[::1\]):(\d+)$/.exec(line)
    if (address && descendant(pid, rootPid, parents)) ports.add(Number(address[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

function validatePid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new RangeError('PID must be a positive integer')
}

async function processParents(): Promise<Map<number, number>> {
  if (process.platform === 'linux') {
    const parents = new Map<number, number>()
    for (const [pid, identity] of await procProcessTable()) parents.set(pid, identity.ppid)
    return parents
  }
  requireSupportedPlatform()
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { env: { LC_ALL: 'C' } })
  const parents = new Map<number, number>()
  for (const line of stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) throw new Error('Unexpected ps process table output')
    parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

function descendant(pid: number, rootPid: number, parents: Map<number, number>): boolean {
  const visited = new Set<number>()
  while (parents.has(pid) && !visited.has(pid)) {
    if (pid === rootPid) return true
    visited.add(pid)
    pid = parents.get(pid) ?? 0
  }
  return false
}

/** 不支持的平台如实返回 unsupported 诊断错误，不抛无码异常、不把未知归属当成通过或不存在。 */
export function requireSupportedPlatform(): void {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new RunnerSessionError({
      code: DiagnosticCode.unsupportedCapability, phase: 'start',
      message: 'Process and port ownership inspection is not implemented on ' + process.platform,
      hint: 'Run on a supported platform (macOS or Linux); there is no ownership-check fallback',
    })
  }
}

async function queryListeners(args: string[]): Promise<string> {
  requireSupportedPlatform()
  try {
    return (await execFileAsync('/usr/sbin/lsof', ['-nP', ...args], { env: { LC_ALL: 'C' } })).stdout
  } catch (error) {
    // lsof 的空匹配用 exit 1 表示；权限/命令错误必须暴露。
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1 &&
        'stdout' in error && error.stdout === '' && 'stderr' in error && error.stderr === '') return ''
    throw error
  }
}
