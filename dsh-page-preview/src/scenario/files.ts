/** 场景响应文件只读边界（方案 §7.2、§8、§13）；Host 预检和 Runner 使用相同范围，不读取环境文件。 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { resolveProjectPath } from '../shared/config/paths.ts'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'

export async function readScenarioBodyFile(appRoot: string, file: string, dependencyRoots?: readonly string[]): Promise<Buffer> {
  try {
    const resolved = await resolveProjectPath(appRoot, file, dependencyRoots)
    if (/^\.env(?:\.|$)/.test(basename(resolved)) || !(await stat(resolved)).isFile()) throw new Error('Invalid scene response file')
    return await readFile(resolved)
  } catch (error) {
    throw new RunnerSessionError({ code: DiagnosticCode.configInvalid, phase: 'scenario', message: 'Scenario response file must exist within the declared roots and cannot be an environment file', hint: 'Use an explicit reviewed fixture file; no substitute response was generated' }, error)
  }
}
