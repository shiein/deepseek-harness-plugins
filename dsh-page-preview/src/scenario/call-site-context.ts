/**
 * 未命中请求的调用点上下文（R6-2，`docs/r6-plan.md` §3 R6-2；方案 §7.2 缺失处理）。
 * 目的：让 Agent 读一次 status 就拿到补数据所需的确定性信息，一轮写回全部 fixture，
 * 而不是逐个接口翻代码。插件只做确定性收集，字段语义推断交给 Agent。
 *
 * 对每个未命中条目（method + path），只读、有界地给出：
 * - requestSites：源码中出现该路径字面量（含模板字符串静态前缀）的请求函数位置与片段；
 *   match 标注匹配方式（exact 字面量相等 / template-prefix 静态前缀 /
 *   suffix baseURL 前缀不一致兜底——只允许"未命中路径以字面量结尾且边界恰在 /"
 *   这一种确定性方向，不确定时不返回，不能误配）。
 *   R6-F1 收紧（宁可不给也不误配）：
 *   a) suffix 至少两个路径段（/menu/list）；/info 这样的单段后缀不入索引；
 *   b) 字面量必须处于请求调用的实参位置——call('/x') 的直接实参、或对象实参里
 *      url 属性的值（容器可经对象/数组嵌套后作实参）；路由表 path、任何声明、
 *      new 表达式、标记模板等其余位置一律不算；
 *   c) 调用目标必须不是已知非请求 API：localStorage/sessionStorage/JSON/console 等
 *      对象上的任意方法，router/history/location/window/document 上的导航类方法
 *      （push/replace/navigate/open/assign/pushState 等，含 this.$router.push），
 *      以及裸 require/navigate；fetch、axios、request 等照常；
 *   d) 同一条目存在 exact/template-prefix 命中时压制 suffix——suffix 只是前缀
 *      不一致的兜底，强匹配存在时其余同值字面量更可能无关；被过滤的命中不占
 *      perEntry 名额，也不注册请求函数（consumers/typeHint 同源过滤）。
 * - consumers：调用这些请求函数的位置，以及对返回值读取的属性链（如 `data.menuList`）；
 * - typeHint：仅当调用点**显式**写出响应类型（请求调用的泛型实参、请求函数返回值注解、
 *   消费调用的泛型实参）时，经 TypeScript checker 展开后的字段结构。any/unknown 不给；
 *   不按 URL 或符号名猜类型（R5-fix1 已删猜名逻辑，不得恢复）。
 *
 * 约束：
 * - 只读静态分析（AST + checker），不导入、不执行、不求值业务代码（Host 可调用，§6.5）。
 * - 同一次 status 只扫一遍源码树，所有未命中条目共享；文件内容只读一次。
 * - 有界：文件数、单文件字节、总耗时、每条目 site/consumer 条数、字段链数、
 *   typeHint 展开深度与字段数都有上限；触顶返回 `limited: true`，由调用方出可见诊断。
 * - 不读 `.env*`，不进 node_modules/dist/build/output/coverage（scanProjectFiles 与
 *   readProjectText 的既有边界）；片段转发前经共享 redactor 脱敏。
 * - 结果只进 fixtureDraft，永远不作为响应体；typeHint 与 shapeHints 同级，值是示例。
 */

import { relative } from 'node:path'
import ts from 'typescript'
import { readProjectText } from '../shared/profile.ts'
import { scanProjectFiles } from '../shared/project-files.ts'
import { parseVueSfc } from '../shared/vue-sfc.ts'
import type { CallSiteContext } from '../shared/fixture-draft.ts'

export interface CallSiteBudget {
  /** 扫描的源码文件上限（默认沿用 scanProjectFiles 的 5000）。 */
  files: number
  /** 总耗时上限（毫秒）；超时返回已收集部分并标 limited。 */
  timeMs: number
  /** 每个条目最多返回的 requestSites / consumers 条数。 */
  perEntry: number
}

export const DEFAULT_CALL_SITE_BUDGET: CallSiteBudget = { files: 5000, timeMs: 1500, perEntry: 3 }

/** 单文件源码字节上限：请求函数模块不会这么大。 */
const FILE_MAX_BYTES = 256 * 1024
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue)$/
/** 片段行字符上限（转发前再经 redactor 限长）。 */
const SNIPPET_LIMIT = 160
/** 每个 consumer 记录的字段链上限。 */
const MAX_FIELDS = 16
/** typeHint 展开的深度/字段数上限。 */
const HINT_MAX_DEPTH = 3
const HINT_MAX_FIELDS = 24
/** typeHint 候选文件作为 program 根的上限（跨文件类型经模块解析自行拉入）。 */
const CHECK_MAX_ROOTS = 64

export interface CallSiteOptions {
  /** 片段脱敏（共享 redactor 的 text）；缺省时只截断。 */
  redact?: (text: string, limit?: number) => string
  /** 测试注入的时间源；默认 Date.now。 */
  now?: () => number
}

type MatchKind = 'exact' | 'template-prefix' | 'suffix'

interface Entry { method: string; path: string }

interface ParsedBlock { tree: ts.SourceFile; lineOffset: number }
interface ParsedFile { rel: string; abs: string; raw: string; lines: string[]; blocks: ParsedBlock[] }

/** 字面量所在的最内层函数信息；匿名/顶层为 undefined name（不进消费者映射）。 */
interface FnMeta {
  name: string | undefined
  fn: ts.Node
  keys: Set<string>
}

interface TypeCandidate { abs: string; rel: string; line: number; start: number; end: number }

/** 一处字面量命中：可见 site 信息 + 供第二趟/类型展开的函数元数据与注解候选。 */
interface SiteHit {
  file: ParsedFile
  line: number
  match: MatchKind
  meta: FnMeta
  candidate: TypeCandidate | undefined
}

/**
 * 为一批未命中条目收集调用点上下文；返回按 `METHOD path` 键索引的结果与是否触顶。
 * 扫描顺序固定（文件名排序），结果与目录枚举顺序无关。
 */
export async function collectCallSiteContext(
  appRoot: string, entries: ReadonlyArray<Entry>,
  budget: CallSiteBudget = DEFAULT_CALL_SITE_BUDGET, options: CallSiteOptions = {},
): Promise<{ contexts: Map<string, CallSiteContext>; limited: boolean }> {
  const now = options.now ?? Date.now
  const deadline = now() + budget.timeMs
  const scan = await scanProjectFiles(appRoot, budget.files)
  let limited = scan.limited

  // 字面量索引：exact（path 全等）与 suffix（path 以字面量结尾且边界在 '/'）。
  // R6-F1：suffix 至少两个路径段——/info 这样的单段后缀会命中无关字面量，不入索引。
  const exact = new Map<string, string[]>()
  const suffix = new Map<string, string[]>()
  const wanted = new Map<string, Entry>()
  for (const entry of entries) {
    const key = entry.method.toUpperCase() + ' ' + entry.path
    wanted.set(key, entry)
    push(exact, entry.path, key)
    for (let i = 1; i < entry.path.length - 1; i++) {
      if (entry.path[i] !== '/') continue
      const part = entry.path.slice(i)
      if (part.indexOf('/', 1) > 0) push(suffix, part, key)
    }
  }

  const consumers = new Map<string, CallSiteContext['consumers']>()
  /** 第一趟收集的全部命中：perEntry 与 suffix 压制在扫描完成后统一判定。 */
  const hits = new Map<string, SiteHit[]>()

  // 唯一一遍源码读取：每文件读一次、解析一次，解析树留在内存供第二趟复用。
  const parsed: ParsedFile[] = []
  for (const abs of [...scan.files].sort()) {
    if (!SOURCE_EXT.test(abs)) continue
    if (now() > deadline) { limited = true; break }
    const raw = await readProjectText(abs, appRoot).catch(() => undefined)
    if (raw === undefined || raw.length > FILE_MAX_BYTES) continue
    const rel = relative(appRoot, abs)
    const file: ParsedFile = { rel, abs, raw, lines: raw.split('\n'), blocks: blocksOf(abs, raw) }
    parsed.push(file)
    for (const block of file.blocks) {
      // 字面量与模板静态前缀命中 → 记入 hits；非请求语法位置（F1 规则 b/c）整批放弃。
      // 遍历用显式栈而非递归：压缩产物的深层二元表达式会让递归栈溢出（见 shared/javascript.ts）。
      const visit = (node: ts.Node) => {
        const matches: Array<{ key: string; match: MatchKind }> = []
        if (ts.isStringLiteralLike(node) && node.text.length > 0) {
          for (const key of exact.get(node.text) ?? []) matches.push({ key, match: 'exact' })
          for (const key of suffix.get(node.text) ?? []) matches.push({ key, match: 'suffix' })
        } else if (ts.isTemplateHead(node) && node.text.length > 1 && node.text.endsWith('/')) {
          for (const [key, entry] of wanted) {
            if (entry.path.startsWith(node.text)) matches.push({ key, match: 'template-prefix' })
          }
        }
        if (!matches.length) return
        const call = requestCallOf(node)
        if (call === undefined || deniedCallee(call)) return
        const meta = enclosing(node)
        const line = lineOf(block.tree, node) + block.lineOffset
        const annotation = fnAnnotation(meta) ?? call.typeArguments?.[0]
        const candidate: TypeCandidate | undefined = annotation === undefined ? undefined
          : { abs, rel, line, start: annotation.getStart(block.tree), end: annotation.getEnd() }
        for (const { key, match } of matches) push(hits, key, { file, line, match, meta, candidate })
      }
      const stack: ts.Node[] = [block.tree]
      while (stack.length) {
        const node = stack.pop()!
        visit(node)
        const children: ts.Node[] = []
        ts.forEachChild(node, child => { children.push(child) })
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
      }
    }
  }

  // R6-F1：同一条目有 exact/template-prefix 命中时压制 suffix；被过滤的命中不占
  // perEntry 名额，也不注册请求函数（consumers/typeHint 与可见 requestSites 同源）。
  const sites = new Map<string, CallSiteContext['requestSites']>()
  const candidates = new Map<string, TypeCandidate[]>()
  /** 具名请求函数：name → 出现该路径字面量的函数记录。 */
  const byName = new Map<string, FnMeta[]>()
  for (const key of wanted.keys()) {
    let kept = hits.get(key) ?? []
    if (kept.some(hit => hit.match !== 'suffix')) kept = kept.filter(hit => hit.match !== 'suffix')
    for (const hit of kept) {
      const meta = hit.meta
      if (meta.name !== undefined) {
        meta.keys.add(key)
        const bucket = byName.get(meta.name) ?? []
        const same = bucket.find(value => value.fn === meta.fn)
        if (same === undefined) bucket.push(meta)
        else for (const k of meta.keys) same.keys.add(k)
        byName.set(meta.name, bucket)
      }
      if (hit.candidate !== undefined) push(candidates, key, hit.candidate)
    }
    if (kept.length > budget.perEntry) { limited = true; kept = kept.slice(0, budget.perEntry) }
    sites.set(key, kept.map(hit => ({ file: hit.file.rel, line: hit.line,
      snippet: snippetOf(hit.file, hit.line, options.redact), match: hit.match })))
  }

  // 第二趟（内存中已解析的树）：请求函数的消费者调用与字段链。
  if (byName.size) for (const file of parsed) {
    if (now() > deadline) { limited = true; break }
    for (const block of file.blocks) {
      const visit = (node: ts.Node) => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return
        const metas = byName.get(node.expression.text)
        if (metas === undefined) return
        const line = lineOf(block.tree, node) + block.lineOffset
        const fields = fieldsOf(node)
        const seen = new Set<string>()
        for (const meta of metas) {
          for (const key of meta.keys) {
            if (seen.has(key)) continue
            seen.add(key)
            const bucket = consumers.get(key) ?? []
            if (bucket.length < budget.perEntry) {
              bucket.push({ file: file.rel, line, snippet: snippetOf(file, line, options.redact), fields })
            } else limited = true
            consumers.set(key, bucket)
            const type = node.typeArguments?.[0]
            if (type !== undefined) {
              push(candidates, key, { abs: file.abs, rel: file.rel, line,
                start: type.getStart(block.tree), end: type.getEnd() })
            }
          }
        }
      }
      const stack: ts.Node[] = [block.tree]
      while (stack.length) {
        const node = stack.pop()!
        visit(node)
        const children: ts.Node[] = []
        ts.forEachChild(node, child => { children.push(child) })
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
      }
    }
  }

  const hinted = candidates.size ? expandTypeHints(candidates) : new Map<string, CallSiteContext['typeHint']>()
  const contexts = new Map<string, CallSiteContext>()
  for (const [key, entry] of wanted) {
    const typeHint = hinted.get(key)
    const context: CallSiteContext = {
      method: entry.method.toUpperCase(),
      path: entry.path,
      requestSites: sites.get(key) ?? [],
      consumers: consumers.get(key) ?? [],
      ...(typeHint === undefined ? {} : { typeHint }),
    }
    if (context.requestSites.length || context.consumers.length || context.typeHint !== undefined) {
      contexts.set(key, context)
    }
  }
  return { contexts, limited }
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const bucket = map.get(key) ?? []
  bucket.push(value)
  map.set(key, bucket)
}

/** 片段：按行截取后经调用方注入的 redactor 脱敏。 */
const snippetOf = (file: ParsedFile, line: number, redact?: CallSiteOptions['redact']): string => {
  const text = (file.lines[line - 1] ?? '').trim().slice(0, SNIPPET_LIMIT)
  return redact === undefined ? text : redact(text, SNIPPET_LIMIT)
}

/**
 * R6-F1 规则 b：字面量必须处于请求调用的实参位置才可能是请求点。
 * - 直接实参：`getRequest('/x')`、`getRequest(`/x/${id}`)`；
 * - 对象实参中 `url` 属性的值：`request({ url: '/x' })`，容器对象可经对象/数组/
 *   括号/as 嵌套后仍作实参；
 * - 其余位置（路由表/配置对象的其他属性、变量声明、new 表达式、标记模板、
 *   非调用的任何上下文）一律返回 undefined——宁可不给也不误配。
 */
function requestCallOf(node: ts.Node): ts.CallExpression | undefined {
  const value = ts.isTemplateHead(node) ? node.parent! : node
  const parent = value.parent
  if (parent !== undefined && ts.isCallExpression(parent)
      && (parent.arguments as readonly ts.Node[]).includes(value)) return parent
  if (parent !== undefined && ts.isPropertyAssignment(parent)
      && propertyText(parent.name) === 'url') {
    let container: ts.Node | undefined = parent.parent
    while (container !== undefined && container.parent !== undefined) {
      const up: ts.Node = container.parent
      if (ts.isCallExpression(up) && (up.arguments as readonly ts.Node[]).includes(container)) return up
      const nestable = ts.isObjectLiteralExpression(up) || ts.isArrayLiteralExpression(up)
        || ts.isPropertyAssignment(up) || ts.isParenthesizedExpression(up) || ts.isAsExpression(up)
      if (!nestable) return undefined
      container = up
    }
  }
  return undefined
}

const propertyText = (name: ts.PropertyName): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined

/**
 * R6-F1 规则 c：确定不是业务请求的调用（宁可不给也不误配）。
 * - NEVER_REQUEST_OBJECTS 上的任意方法：localStorage/sessionStorage/JSON/console 等；
 * - NAV 对象上的导航类方法：router/route/history/location/navigator/window/document
 *   出现在接收者链中（含 this.$router、$route）且方法是 push/replace/navigate/open/
 *   assign/pushState 等取路径做页面导航的；
 * - 裸标识符 require/navigate。
 * fetch、axios、request、http 等不在列——名字不证明请求，但不证明非请求的照常收集。
 */
const NEVER_REQUEST_OBJECTS = new Set([
  'localStorage', 'sessionStorage', 'JSON', 'console', 'Math', 'Intl', 'Reflect',
])
const NAV_RECEIVERS = new Set(['router', 'route', 'history', 'location', 'navigator', 'window', 'document'])
const NAV_METHODS = new Set([
  'push', 'replace', 'navigate', 'go', 'back', 'forward', 'assign', 'reload',
  'open', 'pushState', 'replaceState', 'visit',
])
const NON_REQUEST_IDENTIFIERS = new Set(['require', 'navigate'])

function deniedCallee(call: ts.CallExpression): boolean {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return NON_REQUEST_IDENTIFIERS.has(callee.text)
  if (!ts.isPropertyAccessExpression(callee)) return false
  const parts: string[] = []
  let node: ts.Expression = callee
  while (ts.isPropertyAccessExpression(node)) { parts.unshift(node.name.text); node = node.expression }
  if (ts.isIdentifier(node)) parts.unshift(node.text)
  if (parts.length > 1 && NEVER_REQUEST_OBJECTS.has(parts[0]!)) return true
  const method = parts[parts.length - 1] ?? ''
  return NAV_METHODS.has(method)
    && parts.slice(0, -1).some(part => NAV_RECEIVERS.has(part.replace(/^\$+/, '')))
}

const lineOf = (tree: ts.SourceFile, node: ts.Node): number =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1

/** 文件内可解析块：.vue 取各 <script> 块（lang 决定 ScriptKind，带行偏移），其余整块。 */
function blocksOf(abs: string, raw: string): ParsedBlock[] {
  const kind = (lang: string) =>
    lang === 'tsx' || abs.endsWith('.tsx') || abs.endsWith('.jsx') ? ts.ScriptKind.TSX
      : lang === 'ts' || abs.endsWith('.ts') || abs.endsWith('.mts') || abs.endsWith('.cts') ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX
  if (!abs.endsWith('.vue')) {
    return [{ tree: ts.createSourceFile(abs, raw, ts.ScriptTarget.Latest, true, kind('')), lineOffset: 0 }]
  }
  let scripts
  try { scripts = parseVueSfc(raw).scripts } catch { return [] }
  const out: ParsedBlock[] = []
  let from = 0
  for (const block of scripts) {
    if (block.src !== undefined) continue
    const at = raw.indexOf(block.source, from)
    if (at < 0) continue
    from = at + block.source.length
    out.push({
      tree: ts.createSourceFile(abs + '#' + out.length, block.source, ts.ScriptTarget.Latest, true, kind(block.lang)),
      lineOffset: raw.slice(0, at).split('\n').length - 1,
    })
  }
  return out
}

/** 字面量最内层函数与具名身份（函数名 / const 变量名 / 属性赋值名）。 */
function enclosing(literal: ts.Node): FnMeta {
  let fn: ts.Node = literal
  while (fn.parent !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent
  let name: string | undefined
  if (ts.isFunctionLike(fn)) {
    if (fn.name !== undefined && ts.isIdentifier(fn.name)) name = fn.name.text
    else if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) name = fn.parent.name.text
    else if (ts.isPropertyAssignment(fn.parent)
      && (ts.isIdentifier(fn.parent.name) || ts.isStringLiteralLike(fn.parent.name))) name = fn.parent.name.text
    else if (ts.isMethodDeclaration(fn) && (ts.isIdentifier(fn.name) || ts.isStringLiteralLike(fn.name))) {
      name = fn.name.text
    }
  }
  return { name, fn, keys: new Set() }
}

const fnAnnotation = (meta: FnMeta): ts.TypeNode | undefined =>
  ts.isFunctionLike(meta.fn) ? meta.fn.type ?? undefined : undefined

/**
 * consumer 调用对返回值的字段链读取：
 * - `const v = await call()` → 同作用域内 `v.<链>`；
 * - `call().<链>`；
 * - `call().then(v => …)` → 回调体内 `v.<链>`。
 */
function fieldsOf(call: ts.CallExpression): string[] {
  const fields = new Set<string>()
  const collect = (rootName: string, scope: ts.Node) => {
    const stack: ts.Node[] = [scope]
    while (stack.length) {
      const node = stack.pop()!
      if (ts.isPropertyAccessExpression(node)) {
        const parts: string[] = [node.name.text]
        let inner = node.expression
        while (ts.isPropertyAccessExpression(inner)) { parts.unshift(inner.name.text); inner = inner.expression }
        if (ts.isIdentifier(inner) && inner.text === rootName) {
          if (parts.length <= MAX_FIELDS) fields.add(parts.join('.'))
          continue
        }
      }
      ts.forEachChild(node, child => { stack.push(child) })
    }
  }
  let target: ts.Node | undefined = call.parent
  const unwrap = (node: ts.Node | undefined) => node !== undefined
    && (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isVoidExpression(node))
  while (unwrap(target)) target = target!.parent
  if (target !== undefined && ts.isVariableDeclaration(target) && ts.isIdentifier(target.name)) {
    const scope = ownerScope(target)
    if (scope !== undefined) collect(target.name.text, scope)
  }
  if (target !== undefined && ts.isPropertyAccessExpression(target)) {
    if (['then', 'catch', 'finally'].includes(target.name.text) && target.parent !== undefined
      && ts.isCallExpression(target.parent) && target.parent.expression === target) {
      const arg = target.parent.arguments[0]
      if (arg !== undefined && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const param = arg.parameters[0]
        if (param !== undefined && ts.isIdentifier(param.name)) collect(param.name.text, arg.body)
      }
    } else {
      const parts: string[] = [target.name.text]
      let inner = target.expression
      while (ts.isPropertyAccessExpression(inner)) { parts.unshift(inner.name.text); inner = inner.expression }
      fields.add(parts.join('.'))
    }
  }
  return [...fields].sort().slice(0, MAX_FIELDS)
}

const ownerScope = (node: ts.Node): ts.Node | undefined => {
  let up: ts.Node | undefined = node.parent
  while (up !== undefined && !ts.isFunctionLike(up) && !ts.isSourceFile(up)) up = up.parent
  return up
}

/**
 * typeHint：只为显式类型注解建 checker；候选按 `METHOD path` 归组。
 * program 以候选文件为根（.vue 候选无法进 program，跳过），导入类型经模块解析自行拉入。
 * 解析到 any/unknown、类型名不可读或跨文件候选无法定位时，不给该条目的 hint。
 */
function expandTypeHints(candidates: Map<string, TypeCandidate[]>): Map<string, CallSiteContext['typeHint']> {
  const usable = new Map<string, TypeCandidate[]>()
  for (const [key, list] of candidates) {
    const list2 = list.filter(value => SOURCE_EXT.test(value.abs) && !value.abs.endsWith('.vue'))
    if (list2.length) usable.set(key, list2)
  }
  const roots = [...new Set([...usable.values()].flatMap(list => list.map(value => value.abs)))]
  if (!roots.length || roots.length > CHECK_MAX_ROOTS) return new Map()
  const program = ts.createProgram({
    rootNames: roots,
    options: {
      strict: true, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
      target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
    },
  })
  const checker = program.getTypeChecker()
  const hints = new Map<string, CallSiteContext['typeHint']>()
  for (const [key, list] of usable) {
    for (const candidate of list.slice(0, 4)) {
      const source = program.getSourceFile(candidate.abs)
      if (source === undefined) continue
      const node = locate(source, candidate.start, candidate.end)
      if (node === undefined || !ts.isTypeNode(node)) continue
      const type = unwrapPromise(checker.getTypeFromTypeNode(node), checker)
      if (type === undefined || (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) continue
      const shape = shapeOf(type, checker, 0)
      if (shape === 'unknown') continue
      const name = checker.typeToString(type)
      if (name === 'any' || name === 'unknown') continue
      hints.set(key, {
        shape,
        provenance: 'Explicit type ' + name + ' at ' + candidate.rel + ':' + candidate.line,
      })
      break
    }
  }
  return hints
}

/** program 的 SourceFile 与我方 createSourceFile 文本相同，按位置找回同一 TypeNode。 */
const locate = (root: ts.Node, start: number, end: number): ts.Node | undefined => {
  const stack: ts.Node[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.getStart() === start && node.getEnd() === end) return node
    node.forEachChild(child => {
      if (child.getStart() <= start && child.getEnd() >= end) stack.push(child)
    })
  }
  return undefined
}

const unwrapPromise = (type: ts.Type, checker: ts.TypeChecker): ts.Type | undefined => {
  const name = type.getSymbol()?.getName() ?? type.aliasSymbol?.getName()
  if (name === 'Promise' || name === 'PromiseLike') {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    return args[0]
  }
  return type
}

/**
 * 有界类型展开：对象按属性递归 ≤HINT_MAX_DEPTH 层、每层 ≤HINT_MAX_FIELDS 个；
 * 字面量给字面值，字面量联合给 `a | b`，可空联合剥掉 null/undefined 后继续；
 * 其余（函数、索引签名、映射类型等）给 'unknown' 占位，不猜。
 */
function shapeOf(type: ts.Type, checker: ts.TypeChecker, depth: number): unknown {
  if (depth > HINT_MAX_DEPTH) return '…'
  if (type.isUnion()) {
    const members = type.types
    if (members.every(member => member.isLiteral())) {
      return members.map(member => String((member as ts.LiteralType).value)).join(' | ')
    }
    const rest = members.filter(member => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
    return rest.length === 1 ? shapeOf(rest[0]!, checker, depth) : 'unknown'
  }
  if (type.isStringLiteral()) return type.value
  if (type.isNumberLiteral() || type.flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type)
  if (type.flags & ts.TypeFlags.StringLike) return 'string'
  if (type.flags & ts.TypeFlags.NumberLike) return 'number'
  if (type.flags & ts.TypeFlags.BooleanLike) return 'boolean'
  if (type.flags & ts.TypeFlags.Null) return null
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type as ts.TypeReference)
    return [args[0] === undefined ? 'unknown' : shapeOf(args[0], checker, depth + 1)]
  }
  if (type.flags & ts.TypeFlags.Object) {
    const out: Record<string, unknown> = {}
    for (const prop of type.getProperties().slice(0, HINT_MAX_FIELDS)) {
      const declared = prop.valueDeclaration ?? prop.getDeclarations()?.[0]
      out[prop.name] = declared === undefined ? 'unknown'
        : shapeOf(checker.getTypeOfSymbolAtLocation(prop, declared), checker, depth + 1)
    }
    return out
  }
  return 'unknown'
}
