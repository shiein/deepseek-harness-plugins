/** Host/Runner 共用的配置路径范围核对（方案 §8、§13）；只查元数据，不读取或执行业务模块。 */
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 缺失的末级文件按最近存在父目录解析；父目录符号链接仍须经过真实路径核对。 */
export async function canonicalPath(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Expected an absolute path')
  try { return await realpath(path) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    // 断链不能当作普通缺失文件，否则会丢掉链接指向、错误地接受越界路径。
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Unable to resolve symbolic link')
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await canonicalPath(parent), basename(path))
  }
}

export function isWithinRoot(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep))
}

/** dependencyRoots 是配置声明的查询范围；该声明本身不产生执行批准。 */
export async function resolveProjectPath(appRoot: string, path: string, dependencyRoots: readonly string[] = []): Promise<string> {
  if (!isAbsolute(appRoot) || !path || /^[\\/]|^[A-Za-z]:/.test(path)) throw new Error('Expected an application root and relative project path')
  const root = await realpath(appRoot)
  const target = await canonicalPath(resolve(root, path))
  const allowed = [root, ...await Promise.all(dependencyRoots.map(path => canonicalPath(resolve(root, path))))]
  if (!allowed.some(root => isWithinRoot(root, target))) throw new Error('Configured path is outside application and dependency roots')
  return target
}
