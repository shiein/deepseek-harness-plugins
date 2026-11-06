/**
 * 应用的只读模块依赖图（方案 §5.2；R3-4；F9 自 vue/react impact/module-graph.ts 抽取）。
 * 不加载项目配置、不执行项目代码。
 *
 * 解析范围：
 *   - JS/TS/JSX/TSX：静态 import / export-from / 字面量 dynamic import / require 字面量
 *     （复用 shared/javascript.ts 的 TypeScript AST 能力，不新增解析器依赖）
 *   - 框架特有文件形态经 hooks.expandFile 展开（Vue 的 .vue SFC 块就在 vue/impact 侧提供）；
 *     <script src>/<style src> 视为依赖由钩子原样记录
 *   - 样式：@import / @use / @forward 的字面量路径（css/scss/sass/less/styl 按扩展名）
 *   - 路径解析：相对路径；readonly-config 读出的字面量别名（含 `@/`）；正则/非字面量别名只记入 gaps
 *   - 裸模块（node_modules 包）不入图，记入 bareSpecifiers 供路由模块识别等只读消费
 * 无法静态确定（模板字符串 import、变量 require、glob import）→ gaps，不猜测。
 *
 * 预算：文件数与时间均有限额；超限 → gaps 写明，结果仍可用但标注不完整。
 */
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parseScriptSource } from '../../shared/javascript.ts'
import { scanProjectFiles } from '../../shared/project-files.ts'
import { readProjectText } from '../../shared/profile.ts'
import type { ConfigAlias, ReadonlyBuildConfig } from './readonly-config.ts'

export interface ModuleGraph {
  /** 扫描到的应用内文件全集（相对应用根）；说明符解析的目标域。 */
  files: ReadonlySet<string>
  /** 相对应用根的文件 → 它直接依赖的应用内文件（相对应用根）。 */
  imports: ReadonlyMap<string, readonly string[]>
  /** 反向边：文件 → 直接依赖它的文件。由 imports 推出，便于从改动向上追溯。 */
  importers: ReadonlyMap<string, readonly string[]>
  /** 文件 → 其裸说明符（node_modules 侧）；用于路由模块等只读识别，不入图。 */
  bareSpecifiers: ReadonlyMap<string, readonly string[]>
  /**
   * 无法解析到现存文件的应用内说明符：归一化候选基路径 → 持有该断链的文件。
   * 文件被删除后其 importer 的说明符落在这里，供"删除 → 受影响页面"追溯（不猜，如实 medium）。
   */
  broken: ReadonlyMap<string, readonly string[]>
  gaps: string[]
  /** 预算耗尽或扫描受限时为 true。 */
  partial: boolean
}

export interface ModuleGraphOptions {
  maxFiles?: number
  timeBudgetMs?: number
}

const STYLE_EXT = /\.(?:css|scss|sass|less|styl)$/i
const STYLE_IMPORT = /@(?:import|use|forward)\s+['"]([^'"]+)['"]/g

const toRel = (appRoot: string, file: string) => relative(appRoot, file).split(sep).join('/')
const normalize = (rel: string) => rel.split('\\').join('/')

/** 字面量别名替换：specifier === find 或以 find + '/' 开头；replacement 解析为应用内相对路径。 */
function applyAliases(specifier: string, aliases: readonly ConfigAlias[], appRoot: string)
  : string | 'outside' | undefined {
  for (const alias of aliases) {
    const rest = specifier === alias.find ? ''
      : specifier.startsWith(alias.find + '/') ? specifier.slice(alias.find.length + 1) : undefined
    if (rest === undefined) continue
    // 相对 replacement 含 '..' 片段 → 指向应用外，如实终止而不重新锚定回应用根。
    if (!isAbsolute(alias.replacement) && /(?:^|\/)\.\.(?:\/|$)/.test(alias.replacement)) return 'outside'
    const target = isAbsolute(alias.replacement) ? toRel(appRoot, alias.replacement)
      : normalize(join('/', alias.replacement)).replace(/^\//, '')
    if (target.startsWith('..') || isAbsolute(target)) return 'outside'
    return rest ? target.replace(/\/+$/, '') + '/' + rest : target
  }
  return undefined
}

function opaqueMatched(specifier: string,
  opaque: Array<{ pattern: string, flags: string } | { find: string }>): boolean {
  return opaque.some(alias => 'pattern' in alias
    ? new RegExp(alias.pattern, alias.flags).test(specifier)
    : specifier === alias.find || specifier.startsWith(alias.find + '/'))
}

/** 应用内相对说明符 → 存在的图内文件；未命中返回 undefined。 */
function resolveToFile(relativeSpecifier: string, files: ReadonlySet<string>,
  resolveExts: readonly string[]): string | undefined {
  const base = normalize(join('/', relativeSpecifier)).replace(/^\//, '')
  const candidates = [base, ...resolveExts.map(ext => base + ext),
    ...resolveExts.map(ext => base + '/index' + ext)]
  return candidates.find(candidate => files.has(candidate))
}

export type SpecifierResolution =
  /** 解析到应用内文件（相对应用根）。 */
  | { kind: 'file', path: string }
  /** 字面量别名指向应用外（如包内路径）：第三方终点，不入图。 */
  | { kind: 'outside' }
  /** 裸模块说明符（node_modules）；不入图但可由 bareSpecifiers 消费。 */
  | { kind: 'bare' }
  /** candidate：应用内说明符归一化后的候选基路径（未经扩展名探测），供断链追溯。 */
  | { kind: 'unresolved', reason: 'missing' | 'opaque-alias', candidate?: string }

/** 供 route-map 等消费者复用的统一说明符解析（相对/绝对 → 别名 → 裸说明符），不执行项目解析器。 */
export function resolveModuleSpecifier(appRoot: string, fromRel: string, specifier: string,
  files: ReadonlySet<string>, config: Pick<ReadonlyBuildConfig, 'aliases' | 'opaqueAliases'>,
  resolveExts: readonly string[]): SpecifierResolution {
  if (specifier.startsWith('/') || /^\.{1,2}\//.test(specifier)) {
    // 不以 '/' 重锚：'..' 逃出应用根时保持 unresolved，而不是错配到同名的应用内文件。
    const candidate = specifier.startsWith('/')
      ? normalize(join('/', specifier)).replace(/^\//, '')
      : normalize(join(dirname(fromRel), specifier))
    if (candidate.startsWith('..')) return { kind: 'unresolved', reason: 'missing' }
    const target = resolveToFile(candidate, files, resolveExts)
    return target === undefined ? { kind: 'unresolved', reason: 'missing', candidate }
      : { kind: 'file', path: target }
  }
  const aliased = applyAliases(specifier, config.aliases, appRoot)
  if (aliased === 'outside') return { kind: 'outside' }
  if (aliased !== undefined) {
    const target = resolveToFile(aliased, files, resolveExts)
    return target === undefined ? { kind: 'unresolved', reason: 'missing', candidate: aliased }
      : { kind: 'file', path: target }
  }
  if (opaqueMatched(specifier, config.opaqueAliases)) return { kind: 'unresolved', reason: 'opaque-alias' }
  return { kind: 'bare' }
}

/** expandFile 钩子收到的发射面：与原 moduleSpecifiers 的三个输出桶一一对应。 */
export interface ModuleGraphEmit {
  /** 记一条应用内相对/绝对说明符（不写 rawSpecifier 语义时直接用原字符串）。 */
  relative(specifier: string): void
  /** 记一条静态分析缺口（原样进 gaps）。 */
  gap(message: string): void
  /** 用共享脚本解析跑一段虚拟/真实脚本内容（name 仅用于解析器报错定位）。 */
  script(name: string, text: string): void
}

/** 框架差异的全部注入点（F9）：脚本扩展名判定、说明符解析候选、文件形态展开、配置读取。 */
export interface ModuleGraphHooks {
  /** 需要读源并解析说明符的脚本文件判定（Vue 含 .vue）。 */
  scriptExt: RegExp
  /** 应用内说明符解析时按序尝试的扩展名（Vue 含 .vue）。 */
  resolveExts: readonly string[]
  /** 脚本解析失败时写进 gaps 的标签（保持各框架原措辞）。 */
  scriptGap: string
  /** 读取应用构建别名（只取图解析需要的字段）。 */
  readConfig(appRoot: string): Promise<Pick<ReadonlyBuildConfig, 'aliases' | 'opaqueAliases' | 'unresolved'>>
  /**
   * 框架特有文件形态展开（Vue 的 .vue SFC 块）；返回 true 表示该文件已被钩子处理，
   * 不再走共享的 script/style 分支。无钩子时所有文件走共享分支。
   */
  expandFile?(emit: ModuleGraphEmit, rel: string, source: string): boolean
}

/** 单个文件的直接依赖说明符（裸说明符与应用内相对说明符分开返回）。 */
function moduleSpecifiers(hooks: ModuleGraphHooks, rel: string, source: string)
  : { relative: string[], bare: string[], gaps: string[] } {
  const relative: string[] = []
  const bare: string[] = []
  const gaps: string[] = []
  const collect = (value: string) => {
    if (value.startsWith('/') || /^\.{1,2}\//.test(value)) relative.push(value)
    else bare.push(value)
  }
  const script = (name: string, text: string) => {
    let parsed: ReturnType<typeof parseScriptSource>
    // 解析器内部失败（如对 .d.ts 调 transpileModule）只影响该文件，记 gap 不中断整图。
    try { parsed = parseScriptSource(name, text, { requireLiterals: true }) } catch {
      gaps.push(rel + ': ' + hooks.scriptGap + ' failed static parse')
      return
    }
    if (parsed.invalid) gaps.push(rel + ': ' + hooks.scriptGap + ' failed static parse')
    for (const reference of parsed.references) collect(reference.value)
    for (const issue of parsed.unresolved) gaps.push(rel + ': ' + issue)
  }
  const emit: ModuleGraphEmit = {
    relative: value => relative.push(value),
    gap: message => gaps.push(message),
    script,
  }
  if (hooks.expandFile?.(emit, rel, source)) return { relative, bare, gaps }
  // .d.ts 命中 scriptExt 但声明文件不产生运行时依赖，跳过说明符解析（仍可作为解析目标存在）。
  if (hooks.scriptExt.test(rel) && !/\.d\.ts$/i.test(rel)) script(rel, source)
  else if (STYLE_EXT.test(rel)) for (const match of source.matchAll(STYLE_IMPORT)) relative.push(match[1]!)
  return { relative, bare, gaps }
}

export async function buildModuleGraph(appRoot: string, hooks: ModuleGraphHooks,
  options: ModuleGraphOptions = {}): Promise<ModuleGraph> {
  const scan = await scanProjectFiles(appRoot, options.maxFiles ?? 5000)
  const files = new Set(scan.files.map(file => toRel(appRoot, file)))
  const config = await hooks.readConfig(appRoot)
  const gaps: string[] = []
  const imports = new Map<string, string[]>()
  const bareSpecifiers = new Map<string, string[]>()
  const broken = new Map<string, string[]>()
  const deadline = Date.now() + (options.timeBudgetMs ?? 4000)
  const seen = new Set<string>()
  const queue = [...files]
  let partial = scan.limited
  while (queue.length) {
    const rel = queue.shift()!
    if (seen.has(rel) || !files.has(rel)) continue
    seen.add(rel)
    if (Date.now() > deadline) {
      partial = true
      gaps.push('Module graph exceeded its time budget; dependency coverage is incomplete')
      break
    }
    // 只有源码/样式文件才读取并解析说明符；其余文件（资源、JSON）只作为解析目标存在。
    if (!hooks.scriptExt.test(rel) && !STYLE_EXT.test(rel)) continue
    const source = await readProjectText(join(appRoot, rel), appRoot)
    if (source === undefined) continue
    const specifiers = moduleSpecifiers(hooks, rel, source)
    gaps.push(...specifiers.gaps)
    const dependencies: string[] = []
    const bare: string[] = []
    const link = (specifier: string) => {
      const resolution = resolveModuleSpecifier(appRoot, rel, specifier, files, config, hooks.resolveExts)
      if (resolution.kind === 'file') {
        if (!dependencies.includes(resolution.path)) dependencies.push(resolution.path)
      } else if (resolution.kind === 'bare') {
        // 命中字面量别名的说明符已在 file/unresolved 分支处理；bare 只收真正的 node_modules 侧。
        if (!bare.includes(specifier)) bare.push(specifier)
      } else if (resolution.kind === 'unresolved') {
        if (resolution.candidate !== undefined) {
          const list = broken.get(resolution.candidate) ?? []
          list.push(rel)
          broken.set(resolution.candidate, list)
        }
        gaps.push(rel + ': ' + (resolution.reason === 'opaque-alias'
          ? 'specifier "' + specifier + '" matches a build alias that cannot be evaluated statically'
          : 'unresolved specifier "' + specifier + '"'))
      }
    }
    // 相对/绝对说明符直接归一到应用内路径；裸说明符先过字面量别名，再判定为第三方终点。
    for (const specifier of [...specifiers.relative, ...specifiers.bare]) link(specifier)
    if (dependencies.length) imports.set(rel, dependencies.sort())
    if (bare.length) bareSpecifiers.set(rel, bare.sort())
  }
  const importers = new Map<string, string[]>()
  for (const [file, dependencies] of imports)
    for (const dependency of dependencies) {
      const list = importers.get(dependency) ?? []
      list.push(file)
      importers.set(dependency, list)
    }
  for (const list of importers.values()) list.sort()
  for (const issue of config.unresolved) gaps.push('build config: ' + issue)
  for (const list of broken.values()) list.sort()
  return { files, imports, importers, bareSpecifiers, broken,
    gaps: [...new Set(gaps)].slice(0, 50), partial }
}

/**
 * 断链说明符指向 deletedRel 的 importer 列表（rel 已不存在于 files）。
 * 候选基路径与解析时的扩展名探测同规则；importer 对 deletedRel 的依赖事实本身是静态确定的。
 */
export function brokenImporters(graph: ModuleGraph, deletedRel: string,
  resolveExts: readonly string[]): string[] {
  const hits = new Set<string>()
  for (const [base, importers] of graph.broken) {
    const matches = deletedRel === base || resolveExts.some(ext => deletedRel === base + ext)
      || resolveExts.some(ext => deletedRel === base + '/index' + ext)
    if (matches) for (const importer of importers) hits.add(importer)
  }
  return [...hits].sort()
}

/**
 * 从改动文件沿 importers 向上做有界 BFS，返回每个可达文件及其最短关系链（含改动文件自身）。
 * 深度封顶防环/爆链；调用方再把可达文件与路由表/登记目标求交。
 */
export function reachableImporters(graph: ModuleGraph, changed: string, maxDepth = 12): Map<string, string[]> {
  const reached = new Map<string, string[]>([[changed, [changed]]])
  const queue = [changed]
  while (queue.length) {
    const current = queue.shift()!
    const chain = reached.get(current)!
    if (chain.length > maxDepth) continue
    for (const importer of graph.importers.get(current) ?? []) {
      if (reached.has(importer)) continue
      reached.set(importer, [...chain, importer])
      queue.push(importer)
    }
  }
  return reached
}
