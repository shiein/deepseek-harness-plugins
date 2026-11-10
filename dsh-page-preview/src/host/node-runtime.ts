/** Runner 的 Node 选择（方案 §6.5）；显式路径优先，否则只从用户 PATH 找 Node，不复用 Electron。 */
import { execFile } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { nodeExecutableName, platformBaseEnv } from '../shared/runner/platform-env.ts'
const execute = promisify(execFile)

export async function resolveNodeRuntime(explicit?: string, searchPath = process.env.PATH ?? ''): Promise<{ executable: string; version: string }> {
  if (explicit !== undefined && !isAbsolute(explicit)) throw new Error('Runner Node executable must be absolute')
  const candidates = explicit === undefined
    ? searchPath.split(delimiter).filter(isAbsolute).map(path => join(path, nodeExecutableName()))
    : [explicit]
  let executable: string | undefined
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if (!(await stat(candidate)).isFile()) throw new Error('Runner Node executable is not a file')
      executable = await realpath(candidate)
      break
    } catch (error) {
      if (explicit !== undefined || !(error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code)))) throw error
    }
  }
  if (!executable) throw new Error('Node was not found in the configured path or user PATH')
  // 只运行 Node 自身的版本选项；不继承 NODE_OPTIONS 或工作区环境，不加载业务模块。
  const result = await execute(executable, ['--version'],
    { cwd: tmpdir(), env: platformBaseEnv(), timeout: 3000, maxBuffer: 1024, windowsHide: true })
  const version = result.stdout.trim()
  const match = /^v(\d+)\.(\d+)\.\d+$/.exec(version)
  const major = Number(match?.[1]), minor = Number(match?.[2])
  if (!match || !(major >= 24 || major === 23 && minor >= 6 || major === 22 && minor >= 18)) throw new Error('Runner requires Node 22.18 / 23.6 or newer with native type erasure')
  return { executable, version }
}
