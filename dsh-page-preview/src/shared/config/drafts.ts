/**
 * setup 草稿落盘（方案 §6.9 v1.4 补充条款）。只写插件数据目录，不写项目、不生成批准；
 * 同一工作区的草稿路径稳定，入口变化后以同路径覆盖为新草稿供审阅。
 */
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** 草稿写入 <dataDir>/setup-drafts/<workspace-hash>/<projectId>.draft.js，返回绝对路径。 */
export async function writeSetupDraft(dataDir: string, workspaceRoot: string, projectId: string, source: string): Promise<string> {
  if (!isAbsolute(dataDir) || !isAbsolute(workspaceRoot)) throw new Error('Draft directories must be absolute')
  const workspace = await realpath(workspaceRoot)
  const directory = join(dataDir, 'setup-drafts', createHash('sha256').update(workspace).digest('hex'))
  await mkdir(directory, { recursive: true })
  const file = join(directory, projectId + '.draft.js')
  await writeFile(file, source)
  return file
}
