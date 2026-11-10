/**
 * Windows 只读探针（方案 §9.2、§6.8）：进程表、启动时间、TCP 监听归属。
 *
 * - 进程表与启动时间来自 CIM `Win32_Process`（PowerShell），启动时间取 CreationDate 的 UTC FILETIME
 *   十进制串：定长可比较，既作防 PID 复用的身份，也用于判断父子先后（Windows 不重挂孤儿，PPID
 *   可能指向已退出或被复用的 PID）。
 * - 监听端口来自 `Get-NetTCPConnection -State Listen`：输出不随系统语言变化（netstat 的状态列会本地化）。
 * - Windows 没有进程组；组归属由 process-table.ts 的 `groupMembersOf` 按「组长后代 + 创建时间一致」
 *   判定，此处只提供原始事实。解析函数为纯函数，有合成输出单测；真实 Windows 端到端未验。
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ProcessIdentity } from './process-table.ts'

const execFileAsync = promisify(execFile)

/** 系统自带 Windows PowerShell 5.1 的绝对路径；不依赖 PATH，避免被同名程序劫持。 */
function powershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync(powershellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 })
  return stdout
}

const PROCESS_TABLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  '  if ($_.CreationDate) { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }',
  '}',
].join('\n')

/** 每行 `pid<TAB>ppid<TAB>filetime`。Windows 无进程组：pgid 填自身 PID，组判定见 groupMembersOf。 */
export function parseWinProcessTable(stdout: string): Map<number, ProcessIdentity> {
  const table = new Map<number, ProcessIdentity>()
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = /^(\d+)\t(\d+)\t(\d+)$/.exec(line.trim())
    if (!match) throw new Error('Unexpected Windows process table output')
    const pid = Number(match[1])
    table.set(pid, { pid, ppid: Number(match[2]), pgid: pid, startTime: match[3]! })
  }
  return table
}

export async function winProcessTable(): Promise<Map<number, ProcessIdentity>> {
  return parseWinProcessTable(await powershell(PROCESS_TABLE_SCRIPT))
}

/** 进程不存在时返回 undefined；其余失败（权限、PowerShell 不可用）如实抛出。 */
export async function winProcessStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('PID must be a positive integer')
  const stdout = await powershell([
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'`,
    'if ($p -and $p.CreationDate) { $p.CreationDate.ToFileTimeUtc() }',
  ].join('\n'))
  const text = stdout.trim()
  if (text === '') return undefined
  if (!/^\d+$/.test(text)) throw new Error('Unexpected Windows process start-time output')
  return text
}

export interface WinListener { address: string; port: number; pid: number }

const LISTENERS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {',
  '  "{0}`t{1}`t{2}" -f $_.LocalAddress, $_.LocalPort, $_.OwningProcess',
  '}',
].join('\n')

/** 每行 `address<TAB>port<TAB>pid`；没有任何监听时输出为空。 */
export function parseWinListeners(stdout: string): WinListener[] {
  const listeners: WinListener[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const match = /^(\S+)\t(\d+)\t(\d+)$/.exec(line.trim())
    if (!match) throw new Error('Unexpected Windows TCP listener output')
    listeners.push({ address: match[1]!, port: Number(match[2]), pid: Number(match[3]) })
  }
  return listeners
}

export async function winTcpListeners(): Promise<WinListener[]> {
  return parseWinListeners(await powershell(LISTENERS_SCRIPT))
}

/** 只接受 loopback 监听；`0.0.0.0` / `::` 是所有网卡，不算本机隔离的预览服务。 */
export function isLoopbackAddress(address: string): boolean {
  return address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)
}

/** FILETIME 十进制串比较；返回负数表示 a 早于 b。 */
export function compareStartTime(a: string, b: string): number {
  const left = BigInt(a)
  const right = BigInt(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}
