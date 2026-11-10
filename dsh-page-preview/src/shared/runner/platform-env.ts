/**
 * 子进程的平台必需环境与 Windows 脚本启动（方案 §6.5、§9.2）。
 *
 * Runner、worker 与项目命令只拿调用者明确传入的环境，不继承 Host 环境（凭据与工作区变量不外泄）。
 * 但 Windows 进程缺 `SystemRoot` 时 Winsock 无法初始化（任何监听/连接都失败），缺 `TEMP`/`TMP` 时
 * `os.tmpdir()` 得到无效路径。这几项是操作系统位置，不含用户数据，作为底座补上；POSIX 底座为空。
 *
 * Windows 上 `.cmd`/`.bat`（npm、pnpm、yarn 的入口）不能以 `shell: false` 直接启动（Node 拒绝，
 * CVE-2024-27980），改经 `cmd.exe /d /s /c` 启动，参数逐个加引号；含 `%`、`"` 或换行的参数在 cmd 中
 * 无法安全表达，如实拒绝。真实 Windows 未验。
 */

import { join } from 'node:path'

const WINDOWS_BASE_KEYS = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec'] as const

export function platformBaseEnv(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (platform !== 'win32') return {}
  const env: Record<string, string> = {}
  for (const key of WINDOWS_BASE_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return env
}

/** 底座在前、显式值在后：调用者给的同名键覆盖底座。 */
export function withPlatformBase(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return { ...platformBaseEnv(platform), ...env }
}

/** Runner 在 PATH 中查找 Node 时的文件名。 */
export function nodeExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'node.exe' : 'node'
}

export interface LaunchCommand {
  executable: string
  args: string[]
  windowsVerbatimArguments?: true
}

export class UnsafeWindowsArgumentError extends Error {
  constructor(argument: string) {
    super('A .cmd/.bat command argument cannot be passed safely through cmd.exe: ' + JSON.stringify(argument))
    this.name = 'UnsafeWindowsArgumentError'
  }
}

/** Windows 的 `.cmd`/`.bat` 改经 cmd.exe 启动；其余平台与可执行文件原样返回。 */
export function launchCommand(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): LaunchCommand {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { executable, args }
  const line = [executable, ...args].map(cmdQuote).join(' ')
  const comspec = env.ComSpec || join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  return { executable: comspec, args: ['/d', '/s', '/c', '"' + line + '"'], windowsVerbatimArguments: true }
}

function cmdQuote(value: string): string {
  if (/[%"\r\n\0]/.test(value)) throw new UnsafeWindowsArgumentError(value)
  return /[\s&|<>^(),;=!]/.test(value) || value === '' ? '"' + value + '"' : value
}
