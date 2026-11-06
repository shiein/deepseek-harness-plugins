/** 自有 Vite 预览的固定端点与虚拟模块身份（方案 §6.5、§6.8）；各框架适配器共用同一组受控路径。 */
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
