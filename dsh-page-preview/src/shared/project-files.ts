/** 有界源文件目录索引（方案 §5.1、§5.3）；不读文件内容、不遍历链接目录，显式根本身不因名称被排除。 */
import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
export const SOURCE_EXCLUDES = new Set(['node_modules', 'dist', 'build', 'output', 'coverage'])

export async function scanProjectFiles(root: string, budget = 5000, excludeRoots: readonly string[] = []): Promise<{ files: string[], limited: boolean }> {
  const directories = [root]
  const files: string[] = []
  let entries = 0
  while (directories.length) {
    for await (const entry of await opendir(directories.shift()!)) {
      if (++entries > budget) return { files, limited: true }
      if (entry.name.startsWith('.') || SOURCE_EXCLUDES.has(entry.name)) continue
      const path = join(entry.parentPath, entry.name)
      if (entry.isDirectory() && !excludeRoots.includes(path)) directories.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return { files, limited: false }
}
