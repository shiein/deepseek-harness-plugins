/** 自有 Vite 预览的固定端点与虚拟模块身份（方案 §6.5、§6.8）；各框架适配器共用同一组受控路径。 */
import { posix, win32 } from 'node:path'

export const VITE_PAGE_PATH = '/__dsh_page_preview__/index.html'
export const VITE_HMR_PATH = '/__dsh_page_preview__/hmr'
export const VITE_VIRTUAL_PREFIX = '\0dsh-page-preview:'
export const viteVirtualUrl = (name: string) => '/@id/__x00__dsh-page-preview:' + name

/** 入口文件 → 承接其导入的虚拟模块应声明的 Vite 模块语言；非 TS 入口不声明（与原入口解析语义一致）。 */
export const entryModuleLang = (entry: string): 'ts' | undefined => /\.(?:[cm]?ts|tsx)$/i.test(entry) ? 'ts' : undefined

/**
 * 生成 setup 中已解析的绝对说明符写法：裸绝对路径交 Vite 解析（扩展名补全、TS 导入方的 .js→.ts）。
 * 不用 /@fs/：Vite 视其为已解析路径、原样返回，入口里 `./x.js`（磁盘为 x.ts）或省略扩展名的导入会 404。
 */
export const viteResolvableImport = (file: string) => file.replace(/\\/g, '/')

/**
 * Vite 模块图的文件键（与 Vite normalizePath 一致）：分隔符统一为 `/`；Windows 保留盘符（`C:/a/b`），
 * POSIX 保留前导 `/`。`platform` 只供单测模拟 Windows，运行时取当前平台。
 */
export function viteGraphFile(file: string, platform: NodeJS.Platform = process.platform): string {
  return posix.normalize(platform === 'win32' ? file.replace(/\\/g, '/') : file)
}

/** 绝对文件路径 → Vite 客户端实际请求的 `/@fs/` 路径（Windows：`/@fs/C:/a/b`；POSIX：`/@fs/a/b`）。 */
export function viteFsUrl(file: string, platform: NodeJS.Platform = process.platform): string {
  return '/@fs/' + viteGraphFile(file, platform).replace(/^\/+/, '')
}

/**
 * 已解码的 `/@fs/` 请求路径 → 模块图文件键；Windows 盘符路径不加前导 `/`。不做 normalize：
 * 结果只用于和模块图、计划文件逐字比较，含 `..` 的请求本就不应命中。
 */
export function viteFsUrlFile(pathname: string, platform: NodeJS.Platform = process.platform): string {
  const rest = pathname.slice('/@fs/'.length).replace(/^\/+/, '')
  return platform === 'win32' && /^[A-Za-z]:\//.test(rest) ? rest : '/' + rest
}

/** 按目标平台判断绝对路径：Windows 的 `C:\\x` 不以 `/` 开头，不能用 startsWith('/') 判断。 */
export function isAbsoluteFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  return (platform === 'win32' ? win32 : posix).isAbsolute(file)
}
