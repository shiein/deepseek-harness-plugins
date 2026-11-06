/** 静态文件解析（方案 §6.1、§6.6、§6.8）；Host 预检与 Runner 服务共用同一范围/回退规则，只读元数据。 */
import { realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { isWithinRoot } from './config/paths.ts'

export const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
}

export async function findStaticFile(root: string, pathname: string): Promise<string | undefined> {
  let parts: string[]
  try { parts = decodeURIComponent(pathname).split('/') } catch { return undefined }
  if (parts.some(part => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return undefined
  const candidate = resolve(root, '.' + parts.join('/'))
  if (!isWithinRoot(root, candidate)) return undefined
  try {
    const canonical = await realpath(candidate)
    if (!isWithinRoot(root, canonical) || relative(root, canonical).split(sep).some(part => part.startsWith('.'))) return undefined
    const info = await stat(canonical)
    if (info.isDirectory()) return findStaticFile(root, pathname.replace(/\/$/, '') + '/index.html')
    return info.isFile() && STATIC_CONTENT_TYPES[extname(canonical).toLowerCase()] ? canonical : undefined
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

export async function findStaticDocument(root: string, pathname: string, spaFallback: boolean, navigation: boolean): Promise<string | undefined> {
  const found = await findStaticFile(root, pathname)
  return found ?? (spaFallback && navigation && !extname(pathname) ? findStaticFile(root, '/index.html') : undefined)
}
