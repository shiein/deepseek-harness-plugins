/**
 * React 入口重放（方案 §6.3、§6.9、§0.3 第 10 条；R5-7）。只读 JS/TS/JSX AST，不加载入口或项目配置。
 * 识别 `createRoot(el).render(<Providers><App/></Providers>)`：叶组件（最内层 JSX 元素）替换为预览目标，
 * 其余祖先 JSX 元素按原顺序保留为 layers；BrowserRouter/HashRouter/RouterProvider 在运行时换成
 * MemoryRouter（内存路由上下文，叶子组件内 Link/useNavigate 不因无 Router 崩溃；不执行项目路由表）。
 * 条件/多根/函数包裹的 render、兄弟 JSX、不可求值 props 仍要求手写 setup 或走草稿通道。
 * 原始表达式仅用于本地草稿，不放入诊断或模型可见工具结果；本模块不保存或批准 setup。
 */
import ts from 'typescript'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseScriptSource } from '../../shared/javascript.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { projectDependencyNames, readProjectManifest, readProjectText } from '../../shared/profile.ts'
import { readReactBuildConfig, unwrap } from './readonly-config.ts'
import type { ReadonlyBuildConfig } from './readonly-config.ts'

export type RegistrationKind = 'provider' | 'router' | 'style-import' | 'side-effect-import'
type Origin = 'third-party' | 'business' | 'unresolved'
interface ImportBinding { local: string, imported: string }
interface DraftImport { source: string, resolvedSource: string, bindings: ImportBinding[],
  position: number, /** 解析不合格（缺失/未决别名）的副作用与样式导入：诊断后不写入草稿。 */
  excluded?: boolean }
interface DraftDeclaration { name: string, source: string, position: number }

export interface LayerProp { name: string, text: string }
export type ReplayLayer =
  | {
    kind: 'provider', name: string, source: string, imported?: string, props: LayerProp[],
    imports: string[], declarations: string[], position: number, origin: Origin
  }
  | { kind: 'router', style: 'declarative' | 'data', name: string, imports: string[], position: number }
  | { kind: 'strict', position: number }
export interface EntryRegistration {
  kind: RegistrationKind
  source: string
  imported?: string
  origin: Origin
  location: { file: string, line: number }
}
export interface EntryReplayResult {
  entryFile: string
  registrations: EntryRegistration[]
  diagnostics: string[]
  invalid: boolean
  draft: {
    imports: DraftImport[]
    declarations: DraftDeclaration[]
    identifiers: string[]
    /** 外→内的祖先 JSX 层（叶除外），保持入口顺序。 */
    layers: ReplayLayer[]
    /** 叶 JSX 元素标签名（被预览目标替换的业务根）。 */
    leaf?: string
    /** react-router(-dom) 已安装：运行时可用 MemoryRouter 提供路由上下文。 */
    routerAvailable: boolean
    /** 项目入口使用数据路由（createBrowserRouter/RouterProvider）；v1 仍以 MemoryRouter 上下文挂载叶子。 */
    dataRouter: boolean
  }
}
interface Dependencies {
  sources: Set<string>
  imports: Set<string>
  declarations: Set<string>
  unknown: boolean
}
const empty = (): Dependencies => ({ sources: new Set(), imports: new Set(), declarations: new Set(), unknown: false })
function merge(...items: Dependencies[]): Dependencies {
  const value = empty()
  for (const item of items) {
    item.sources.forEach(source => value.sources.add(source))
    item.imports.forEach(name => value.imports.add(name))
    item.declarations.forEach(name => value.declarations.add(name))
    value.unknown ||= item.unknown
  }
  return value
}
const unknown = (): Dependencies => ({ ...empty(), unknown: true })
const style = (source: string) => /\.(?:css|scss|sass|less|styl|stylus)$/i.test(source)
const packageName = (source: string) => /^(?:@[a-z0-9_.-]+\/[a-z0-9_.-]+|[a-z0-9_.-]+)(?=\/|$)/i.exec(source)?.[0]
const ROUTER_TAGS = new Set(['BrowserRouter', 'HashRouter', 'MemoryRouter', 'RouterProvider'])

const opaqueSpecifier = (config: ReadonlyBuildConfig, specifier: string): boolean =>
  config.opaqueAliases.some(alias => {
    if ('find' in alias) return specifier === alias.find || specifier.startsWith(alias.find + '/')
    try { return new RegExp(alias.pattern, alias.flags.replace(/[gy]/g, '')).test(specifier) } catch { return false }
  })

function specifierOrigin(config: ReadonlyBuildConfig, dependencies: ReadonlySet<string>, specifier: string): Origin {
  if (specifier.startsWith('.') || isAbsolute(specifier)
    || specifier.startsWith('@/') || specifier.startsWith('~/')) return 'business'
  if (opaqueSpecifier(config, specifier)) return 'business'
  if (config.aliasesUnknown) return 'unresolved'
  const aliases = config.aliases.filter(alias => specifier === alias.find || specifier.startsWith(alias.find + '/'))
  if (aliases.length > 1) return 'unresolved'
  if (aliases[0]) {
    const replacement = aliases[0].replacement
    if (replacement.startsWith('.') || isAbsolute(replacement)) return 'business'
    const name = packageName(replacement)
    return name && dependencies.has(name) ? 'third-party' : 'unresolved'
  }
  const name = packageName(specifier)
  return name && dependencies.has(name) ? 'third-party' : 'unresolved'
}

export function resolveModuleSpecifier(config: ReadonlyBuildConfig, dependencies: ReadonlySet<string>,
  root: string, importerFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return resolve(dirname(importerFile), specifier)
  if (opaqueSpecifier(config, specifier)) return specifier
  const alias = config.aliases.find(alias => specifier === alias.find || specifier.startsWith(alias.find + '/'))
  if (alias && (isAbsolute(alias.replacement) || alias.replacement.startsWith('.'))) {
    return resolve(root, alias.replacement + specifier.slice(alias.find.length))
  }
  return specifierOrigin(config, dependencies, specifier) === 'third-party' ? specifier : undefined
}

/** entryFile 相对应用根；绝对路径也必须通过同一真实范围检查。 */
export async function parseEntryRegistrations(appRoot: string, entryFile: string): Promise<EntryReplayResult> {
  const root = await realpath(appRoot)
  const file = await resolveProjectPath(root, relative(root, resolve(root, entryFile)) || '.')
  const source = await readProjectText(file, root)
  if (source === undefined) throw new Error('React entry is missing')
  const result: EntryReplayResult = { entryFile: file, registrations: [], diagnostics: [], invalid: false,
    draft: { imports: [], declarations: [], identifiers: [], layers: [], routerAvailable: false, dataRouter: false } }
  if (parseScriptSource(file, source).invalid) {
    result.invalid = true
    result.diagnostics.push('Entry syntax is invalid; no replay draft can be generated')
    return result
  }
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const config = await readReactBuildConfig(root)
  result.diagnostics.push(...config.unresolved)
  const manifest = join(root, 'package.json')
  const dependencies = new Set(projectDependencyNames(await readProjectManifest(manifest, root), manifest))
  result.draft.routerAvailable = dependencies.has('react-router-dom') || dependencies.has('react-router')
  const imports = new Map<string, { item: DraftImport, imported: string }>()
  const constants = new Map<string, ts.VariableDeclaration>()
  const unsafe = new Set<string>()
  const names = new Set<string>()
  const collectNames = (node: ts.Node) => {
    if (ts.isIdentifier(node)) names.add(node.text)
    ts.forEachChild(node, collectNames)
  }
  collectNames(tree)
  result.draft.identifiers = [...names]
  const originOf = (specifier: string): Origin => specifierOrigin(config, dependencies, specifier)
  const resolvedSource = (specifier: string): string | undefined =>
    resolveModuleSpecifier(config, dependencies, root, file, specifier)
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
      && !statement.importClause?.isTypeOnly) {
      const specifier = statement.moduleSpecifier.text
      const item: DraftImport = {
        source: specifier, resolvedSource: resolvedSource(specifier) ?? specifier,
        bindings: [], position: statement.end,
      }
      const add = (local: string, imported: string) => {
        if (imports.has(local)) unsafe.add(local)
        item.bindings.push({ local, imported }); imports.set(local, { item, imported })
      }
      const clause = statement.importClause
      if (clause?.name) add(clause.name.text, 'default')
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) add(named.name.text, '*')
      if (named && ts.isNamedImports(named)) for (const element of named.elements) {
        if (!element.isTypeOnly) add(element.name.text, element.propertyName?.text ?? element.name.text)
      }
      if (!clause || item.bindings.length) result.draft.imports.push(item)
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          if (constants.has(declaration.name.text) || imports.has(declaration.name.text))
            unsafe.add(declaration.name.text)
          constants.set(declaration.name.text, declaration)
        }
      }
    }
  }
  const baseName = (input: ts.Node): string | undefined => {
    const node = unwrap(input)
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return baseName(node.expression)
    return undefined
  }
  const mutations = (node: ts.Node) => {
    const assignment = ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    if (assignment) {
      const name = baseName(node.left)
      if (name) unsafe.add(name)
    }
    const increment = (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    if (increment) {
      const name = baseName(node.operand)
      if (name) unsafe.add(name)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = baseName(node.expression.expression)
      if (name && constants.has(name)) unsafe.add(name)
    }
    ts.forEachChild(node, mutations)
  }
  mutations(tree)
  const analyze = (input: ts.Node, seen = new Set<string>()): Dependencies => {
    const node = unwrap(input)
    const literal = [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || literal.includes(node.kind)) return empty()
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined' && !constants.has(node.text) && !imports.has(node.text)) return empty()
      if (unsafe.has(node.text) || seen.has(node.text)) return unknown()
      const binding = imports.get(node.text)
      if (binding) return {
        sources: new Set([binding.item.source]), imports: new Set([node.text]),
        declarations: new Set(), unknown: false,
      }
      const declaration = constants.get(node.text)
      if (!declaration?.initializer) return unknown()
      const value = analyze(declaration.initializer, new Set([...seen, node.text]))
      value.declarations.add(node.text)
      return value
    }
    if (ts.isPropertyAccessExpression(node)) return analyze(node.expression, seen)
    if (ts.isElementAccessExpression(node) && node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression)) return analyze(node.expression, seen)
    if (ts.isArrayLiteralExpression(node)) return merge(...node.elements.map(value => analyze(value, seen)))
    if (ts.isObjectLiteralExpression(node)) return merge(...node.properties.map(value => {
      const named = value.name !== undefined && (ts.isIdentifier(value.name)
        || ts.isStringLiteralLike(value.name) || ts.isNumericLiteral(value.name))
      if (ts.isPropertyAssignment(value) && named) return analyze(value.initializer, seen)
      if (ts.isShorthandPropertyAssignment(value) && !value.objectAssignmentInitializer)
        return analyze(value.name, seen)
      return unknown()
    }))
    const unary = [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.ExclamationToken]
    if (ts.isPrefixUnaryExpression(node) && unary.includes(node.operator)) return analyze(node.operand, seen)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = analyze(node.expression, seen)
      const foreign = [...callee.sources].some(source => originOf(source) !== 'third-party')
      if (!callee.sources.size || callee.unknown || foreign) return unknown()
      return merge(callee, ...(node.arguments ?? []).map(value => analyze(value, seen)))
    }
    return unknown()
  }
  const classify = (value: Dependencies): Origin => {
    const origins = [...value.sources].map(source => originOf(source))
    if (value.unknown || origins.includes('unresolved')) return 'unresolved'
    return origins.includes('business') || !value.sources.size ? 'business' : 'third-party'
  }
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const unconditional = (input: ts.Node) => {
    let node = input
    while (node.parent && !ts.isSourceFile(node.parent)) {
      const parent = node.parent
      const statementParent = ts.isExpressionStatement(parent) || ts.isVariableStatement(parent)
        || ts.isVariableDeclarationList(parent) || ts.isParenthesizedExpression(parent)
        || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)
      if (statementParent) { node = parent; continue }
      const wrappedChild = ts.isVariableDeclaration(parent) && parent.initializer === node
        || ts.isPropertyAccessExpression(parent) && parent.expression === node
        || ts.isCallExpression(parent) && parent.expression === node
        || ts.isBinaryExpression(parent) && parent.right === node
          && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      if (wrappedChild) { node = parent; continue }
      return false
    }
    return true
  }
  // createRoot 判定：import { createRoot } from 'react-dom/client' 或 ReactDOM.createRoot。
  const isCreateRoot = (node: ts.Node): boolean => {
    node = unwrap(node)
    if (ts.isIdentifier(node)) {
      const binding = imports.get(node.text)
      return binding?.item.source === 'react-dom/client' && binding.imported === 'createRoot'
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'createRoot' && ts.isIdentifier(node.expression)) {
      const binding = imports.get(node.expression.text)
      return binding !== undefined && ['react-dom', 'react-dom/client'].includes(binding.item.source)
    }
    return false
  }
  const renders: ts.CallExpression[] = []
  const wrappedRenders: ts.CallExpression[] = []
  const collectRenders = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'render') {
      const receiver = unwrap(node.expression.expression)
      let create: ts.CallExpression | undefined
      if (ts.isCallExpression(receiver) && isCreateRoot(receiver.expression)) create = receiver
      else if (ts.isIdentifier(receiver)) {
        const declaration = constants.get(receiver.text)
        const init = declaration?.initializer && unwrap(declaration.initializer)
        if (init && ts.isCallExpression(init) && isCreateRoot(init.expression)) create = init
      }
      if (create) {
        if (unconditional(node)) renders.push(node)
        else wrappedRenders.push(node)
      }
    }
    ts.forEachChild(node, collectRenders)
  }
  collectRenders(tree)
  for (const node of wrappedRenders)
    result.diagnostics.push('Conditional or wrapped React render at line ' + line(node) + ' requires manual setup')
  const isStrictTag = (tag: ts.JsxTagNameExpression): boolean => {
    if (ts.isIdentifier(tag)) {
      const binding = imports.get(tag.text)
      return binding?.item.source === 'react' && binding.imported === 'StrictMode'
    }
    if (ts.isPropertyAccessExpression(tag) && tag.name.text === 'StrictMode' && ts.isIdentifier(tag.expression)) {
      return imports.get(tag.expression.text)?.item.source === 'react'
    }
    return false
  }
  const tagName = (element: ts.JsxElement | ts.JsxSelfClosingElement): string | undefined => {
    const tag = ts.isJsxElement(element) ? element.openingElement.tagName : element.tagName
    if (ts.isIdentifier(tag)) return tag.text
    if (ts.isPropertyAccessExpression(tag)) return tag.getText(tree)
    return undefined
  }
  type JsxChild = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | ts.JsxExpression
  const elementChildren = (element: ts.JsxElement): JsxChild[] =>
    element.children.filter((child): child is JsxChild => ts.isJsxElement(child)
      || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child) || ts.isJsxExpression(child))
  type JsxAnalysis = { chain: Array<ts.JsxElement | ts.JsxSelfClosingElement>,
    leaf?: ts.JsxElement | ts.JsxSelfClosingElement } | 'invalid'
  const analyzeJsx = (element: ts.JsxElement | ts.JsxSelfClosingElement): JsxAnalysis => {
    const chain: Array<ts.JsxElement | ts.JsxSelfClosingElement> = []
    let current: ts.JsxElement | ts.JsxSelfClosingElement = element
    for (;;) {
      if (!tagName(current)) return 'invalid'
      const kids = ts.isJsxElement(current) ? elementChildren(current) : []
      const elements = kids.filter(kid => !ts.isJsxExpression(kid))
      const expressions = kids.filter((kid): kid is ts.JsxExpression =>
        ts.isJsxExpression(kid) && kid.expression !== undefined)
      if (elements.length === 0 && expressions.length === 0) return { chain, leaf: current }
      // 单个子 JSX 表达式 {x} 且 x 本身是 JSX 元素时视为透明包裹。
      if (elements.length === 0 && expressions.length === 1) {
        const inner = unwrap(expressions[0]!.expression!)
        if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner)) {
          chain.push(current); current = inner; continue
        }
        return 'invalid'
      }
      if (elements.length !== 1 || expressions.length !== 0) return 'invalid'
      chain.push(current)
      const next = elements[0]!
      if (ts.isJsxFragment(next)) {
        const fragKids = next.children.filter((kid): kid is ts.JsxElement | ts.JsxSelfClosingElement =>
          ts.isJsxElement(kid) || ts.isJsxSelfClosingElement(kid))
        if (fragKids.length !== 1) return 'invalid'
        current = fragKids[0]!
        continue
      }
      current = next as ts.JsxElement | ts.JsxSelfClosingElement
    }
  }
  for (const item of result.draft.imports) {
    const declaration = tree.statements.find(node => node.end === item.position)!
    if (style(item.source)) {
      const resolved = resolvedSource(item.source)
      const projectResolved = opaqueSpecifier(config, item.source)
      const local = !projectResolved && resolved && isAbsolute(resolved)
        ? await resolveProjectPath(root, relative(root, resolved) || '.').catch(() => undefined) : undefined
      const available = projectResolved || (local ? await readProjectText(local, root) !== undefined
        : originOf(item.source) === 'third-party')
      const eligible = resolved !== undefined && available && !config.aliasesUnknown
      if (resolved) item.resolvedSource = local ?? resolved
      result.registrations.push({ kind: 'style-import', source: item.source,
        origin: eligible ? originOf(item.source) : 'unresolved', location: { file, line: line(declaration) } })
      if (!eligible) {
        item.excluded = true
        result.diagnostics.push('Entry style-import at line ' + line(declaration) + ' requires manual setup')
      }
    } else if (!item.bindings.length) {
      const resolved = resolvedSource(item.source)
      const origin = originOf(item.source)
      const eligible = origin !== 'unresolved' && resolved !== undefined
      result.registrations.push({ kind: 'side-effect-import', source: item.source,
        origin: eligible ? origin : 'unresolved', location: { file, line: line(declaration) } })
      if (!eligible) {
        item.excluded = true
        result.diagnostics.push('Entry side-effect-import at line ' + line(declaration)
          + ' requires manual setup')
      }
    }
  }
  if (renders.length > 1) result.diagnostics.push('Several React roots require explicit manual setup')
  if (!renders.length) {
    if (!wrappedRenders.length)
      result.diagnostics.push('React root render cannot be resolved; manual setup is required')
    return result
  }
  const render = renders[0]!
  const argument = render.arguments[0]
  if (!argument) {
    result.diagnostics.push('React render has no JSX argument; manual setup is required')
    return result
  }
  const rootExpression = unwrap(argument)
  let rootElement: ts.JsxElement | ts.JsxSelfClosingElement | undefined
  if (ts.isJsxElement(rootExpression) || ts.isJsxSelfClosingElement(rootExpression)) rootElement = rootExpression
  if (!rootElement) {
    result.diagnostics.push('React render argument is not a JSX element; manual setup is required')
    return result
  }
  const analyzed = analyzeJsx(rootElement)
  if (analyzed === 'invalid') {
    result.diagnostics.push('React render JSX has sibling/expression children that cannot be replayed; '
      + 'manual setup is required')
    return result
  }
  const { chain, leaf } = analyzed
  for (const element of chain) {
    const tag = ts.isJsxElement(element) ? element.openingElement.tagName : element.tagName
    const name = tagName(element)!
    if (isStrictTag(tag)) {
      result.draft.layers.push({ kind: 'strict', position: element.end })
      continue
    }
    const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes
    const tagBinding = imports.get(name)
    const tagDeps: Dependencies = tagBinding
      ? { sources: new Set([tagBinding.item.source]), imports: new Set([name]),
        declarations: new Set(), unknown: false }
      : unknown()
    const isRouter = ROUTER_TAGS.has(name) && tagBinding !== undefined
      && ['react-router-dom', 'react-router'].includes(tagBinding.item.source)
    if (isRouter) {
      const styleKind = name === 'RouterProvider' ? 'data' : 'declarative'
      if (styleKind === 'data') result.draft.dataRouter = true
      result.draft.layers.push({ kind: 'router', style: styleKind, name, imports: [name], position: element.end })
      result.registrations.push({ kind: 'router', source: tagBinding.item.source,
        imported: tagBinding.imported, origin: 'third-party', location: { file, line: line(element) } })
      continue
    }
    // 属性表达式逐个求依赖；spread 或不可求值表达式标 unresolved。
    let deps = empty()
    let unresolvable = false
    const props: LayerProp[] = []
    for (const attribute of attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) { unresolvable = true; break }
      const propName = attribute.name.getText(tree)
      const init = attribute.initializer
      if (!init) { props.push({ name: propName, text: 'true' }); continue }
      if (ts.isStringLiteralLike(init)) { props.push({ name: propName, text: JSON.stringify(init.text) }); continue }
      if (ts.isJsxExpression(init) && init.expression) {
        const value = analyze(init.expression)
        if (value.unknown) { unresolvable = true; break }
        deps = merge(deps, value)
        props.push({ name: propName, text: init.expression.getText(tree) })
        continue
      }
      unresolvable = true
      break
    }
    const all = merge(tagDeps, deps)
    if (unresolvable || !tagBinding) all.unknown = true
    const origin = classify(all)
    result.draft.layers.push({ kind: 'provider', name, source: tagBinding?.item.source ?? '',
      ...(tagBinding ? { imported: tagBinding.imported } : {}),
      props, imports: [...all.imports], declarations: [...all.declarations], position: element.end, origin })
    result.registrations.push({ kind: 'provider', source: tagBinding?.item.source ?? '',
      ...(tagBinding ? { imported: tagBinding.imported } : {}), origin,
      location: { file, line: line(element) } })
    if (origin === 'unresolved')
      result.diagnostics.push('Provider ' + name + ' at line ' + line(element)
        + ' cannot be resolved; manual setup required')
  }
  if (leaf) {
    const name = tagName(leaf)
    if (name !== undefined) result.draft.leaf = name
    const binding = name ? imports.get(name) : undefined
    // 叶子本身是路由组件（`<RouterProvider router={router}/>` 的 data-router 入口）：
    // 路由层包住预览目标，否则目标内 Link/useNavigate 无上下文。
    const isRouter = name !== undefined && ROUTER_TAGS.has(name) && binding !== undefined
      && ['react-router-dom', 'react-router'].includes(binding.item.source)
    if (isRouter && binding) {
      const styleKind = name === 'RouterProvider' ? 'data' : 'declarative'
      if (styleKind === 'data') result.draft.dataRouter = true
      result.draft.layers.push({ kind: 'router', style: styleKind, name, imports: [name],
        position: leaf.end })
      result.registrations.push({ kind: 'router', source: binding.item.source,
        imported: binding.imported, origin: 'third-party', location: { file, line: line(leaf) } })
    } else {
      result.registrations.push({ kind: 'provider', source: binding?.item.source ?? '',
        ...(binding ? { imported: binding.imported } : {}),
        origin: binding ? classify(analyze(leaf)) : 'business',
        location: { file, line: line(leaf) } })
    }
  }
  // 生成器需要的业务常量声明源码（props 表达式依赖的顶层 const）。
  for (const layer of result.draft.layers) {
    if (layer.kind !== 'provider') continue
    for (const name of layer.declarations) {
      if (result.draft.declarations.some(value => value.name === name)) continue
      const declaration = constants.get(name)
      const statement = declaration?.parent?.parent
      if (statement && ts.isVariableStatement(statement)) {
        result.draft.declarations.push({ name, source: statement.getText(tree), position: statement.end })
      }
    }
  }
  // 其余顶层语句（import/const/已识别的 render 调用之外）如实诊断——不搬运业务初始化调用。
  for (const statement of tree.statements) {
    const declaration = ts.isImportDeclaration(statement) || ts.isVariableStatement(statement)
      || ts.isFunctionDeclaration(statement) || ts.isExportDeclaration(statement)
    if (declaration) continue
    if (ts.isExpressionStatement(statement)) {
      const call = ts.isCallExpression(statement.expression) ? statement.expression : undefined
      if (call && renders.includes(call)) continue
    }
    result.diagnostics.push('Entry statement at line ' + line(statement)
      + ' is not replayed; move it into setup if required')
  }
  return result
}
