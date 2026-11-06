/**
 * 项目 vite-plugin-mock 的受控执行（R5-1e，方案 §7.2「复用项目已有 Mock」）。
 *
 * 只在声明了 vite-plugin-mock 且选项可被 readonly-config 完整静态求值的 Vite 预览中执行；
 * 插件本体从项目 node_modules 解析（项目代码 → 由执行指纹/审批覆盖）。
 * bundleRequire 会把 *.bundled_*.mjs 临时产物写进 mock 目录，先把 mockPath 复制到
 * temporaryRoot 再执行，避免在业务目录落文件（§5 第 4 条）；复制产物中的
 * `import 'mockjs'` 等裸导入经 temporaryRoot/node_modules 软链回项目依赖解析，
 * mockPath 之外的相对导入（如 ../src/x）不复制。
 * 覆盖面核实（F6）：锁定版 vite-plugin-mock 3.0.2 的路由表是模块私有变量（dist/index.mjs
 * `let mockData`），且 getMockConfig 对任一文件 bundleRequire 失败即整表置 [] 后仍注册
 * 中间件——空表无法从插件对象读出。因此复制前静态检查 mock 文件的相对导入是否越出
 * mockPath（`projectMockEscapes`），越界即视为加载失败：调用方发 project_mock_unavailable，
 * 计划层也不声明 project 覆盖。
 * 覆盖面边界：声明的 businessPaths 由场景层独占（含未命中 404），项目 Mock 只能应答
 * businessPaths 之外的同源路径；跨源 remote 请求不经过它。
 */
import { cp, mkdir, readFile, stat, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { isWithinRoot } from '../../shared/config/paths.ts'
import { scanProjectFiles } from '../../shared/project-files.ts'
import type { Middleware } from '../../runner/response-layer/server.ts'

export interface ProjectMock {
  /** connect 风格中间件链；未命中时 next() 落到调用方的未命中分支。 */
  middlewares: Middleware[]
  /** 实际执行的 mock 目录副本（temporaryRoot 内）。 */
  directory: string
}

/** 相对导入越出 mockPath 的事实记录：file 相对 mock 根、specifier 为原文（不含解析后内容）。 */
export interface ProjectMockEscape { file: string, specifier: string }

/**
 * 复制前的静态核实（F6）：mock 文件的相对导入说明符解析到 mockPath 之外即越界。
 * 只查插件实际枚举的 .ts/.mjs/.js 文件（fg 模式 `*.{ts,mjs,js}`）；type-only import/export 会被 bundleRequire
 * 擦除、不参与解析，不计越界；动态 import/require 的非字面量参数无法静态判定，如实跳过
 * （该形状越界时仍会落到运行时诊断）。
 */
export async function projectMockEscapes(appRoot: string, mockPath: string): Promise<ProjectMockEscape[]> {
  const source = resolve(appRoot, mockPath)
  if (!isWithinRoot(appRoot, source) || !(await stat(source).catch(() => undefined))?.isDirectory()) return []
  const scan = await scanProjectFiles(source, 200)
  const escapes: ProjectMockEscape[] = []
  const scripts = scan.files
    .filter(value => isWithinRoot(source, value) && /\.(?:ts|mjs|js)$/.test(value)).sort()
  for (const file of scripts) {
    const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
    const specifiers: string[] = []
    const stack: ts.Node[] = [tree]
    while (stack.length) {
      const node = stack.pop()!
      const typeOnly = ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true
        || ts.isExportDeclaration(node) && node.isTypeOnly
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !typeOnly
          && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        specifiers.push(node.arguments[0].text)
      ts.forEachChild(node, child => { stack.push(child) })
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue
      if (!isWithinRoot(source, resolve(dirname(file), specifier)))
        escapes.push({ file: relative(source, file), specifier })
    }
  }
  return escapes.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier))
}

/** 加载失败归为一类返回 undefined；调用方据此发诊断并继续（不静默、不阻断）。 */
export async function loadProjectMock(appRoot: string, mockPath: string,
  temporaryRoot: string): Promise<ProjectMock | undefined> {
  const source = resolve(appRoot, mockPath)
  if (!isWithinRoot(appRoot, source) || !(await stat(source).catch(() => undefined))?.isDirectory()) return undefined
  // 越界相对导入在复制副本里必解析失败、插件静默降级为空表（F6）——核实失败视同加载失败。
  if ((await projectMockEscapes(appRoot, mockPath)).length) return undefined
  const directory = join(temporaryRoot, 'project-mock')
  await mkdir(temporaryRoot, { recursive: true })
  await cp(source, directory, { recursive: true })
  // 复制的 mock 文件里的裸导入（mockjs 等）按 node 上行解析回项目依赖；符号链接失败不阻断，
  // mock 文件随后解析失败时插件自身降级为空表。
  await symlink(join(appRoot, 'node_modules'), join(temporaryRoot, 'node_modules'), 'dir').catch(() => undefined)
  const specifier = createRequire(join(appRoot, 'package.json')).resolve('vite-plugin-mock')
  const loaded = await import(pathToFileURL(specifier).href) as {
    viteMockServe?: (options: Record<string, unknown>) => unknown
    default?: { viteMockServe?: (options: Record<string, unknown>) => unknown }
  }
  const factory = loaded?.viteMockServe ?? loaded.default?.viteMockServe
  if (typeof factory !== 'function') return undefined
  // 只传运行时受控选项：mockPath 指向 temporaryRoot 副本；watchFiles 关闭（副本不随源变化，假装热重载不诚实）。
  const plugin = factory({ mockPath: directory, watchFiles: false, logger: false }) as {
    configResolved?: (config: { command: 'serve', env: Record<string, unknown>, mode: string, root: string }) => unknown
    configureServer?: (server: { middlewares: { use: (middleware: Middleware) => void } }) => unknown
  }
  if (typeof plugin.configureServer !== 'function') return undefined
  await plugin.configResolved?.({ command: 'serve', env: {}, mode: 'development', root: appRoot })
  const middlewares: Middleware[] = []
  await plugin.configureServer({ middlewares: { use: middleware => middlewares.push(middleware) } })
  return middlewares.length ? { middlewares, directory } : undefined
}

/** 指纹输入：mock 源目录内文件与插件 package.json；失败返回空列表，调用方只记录可读的。 */
export async function projectMockFiles(appRoot: string, mockPath: string): Promise<string[]> {
  const source = resolve(appRoot, mockPath)
  if (!isWithinRoot(appRoot, source) || !(await stat(source).catch(() => undefined))?.isDirectory()) return []
  const scan = await scanProjectFiles(source, 200)
  return scan.files.filter(file => isWithinRoot(source, file)).sort()
}

/** 读插件 package.json（指纹输入之一）；缺失返回 undefined。 */
export async function projectMockManifest(appRoot: string): Promise<string | undefined> {
  try {
    const specifier = createRequire(join(appRoot, 'package.json')).resolve('vite-plugin-mock/package.json')
    return await readFile(specifier, 'utf8')
  } catch { return undefined }
}
