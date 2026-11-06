/** Runner 控制账本与服务账本的固定位置（方案 §9.2）；输入工作区须已规范化，不做 IO。 */
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
export function runnerPaths(dataDir: string, workspaceRoot: string) {
  if (!isAbsolute(dataDir) || !isAbsolute(workspaceRoot)) throw new Error('Runner directories must be absolute')
  const key = createHash('sha256').update(workspaceRoot).digest('hex')
  return { control: join(dataDir, 'runners', key), services: join(dataDir, 'runtime', key) }
}
