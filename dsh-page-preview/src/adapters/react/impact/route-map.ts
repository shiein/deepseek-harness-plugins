/**
 * React Router 路由表的只读映射：路由 path ↔ 页面组件文件（方案 §5.2、§6.6；R5-7）。
 *
 * 只识别静态可确定的形态，其余进 gaps：
 *   - createBrowserRouter/createHashRouter/createMemoryRouter(routes) 的 routes 数组字面量
 *     （数组可经同文件 const 引用或静态 import 绑定跨文件解析一跳）
 *   - 对象项：{ path: '字面量', element: <Foo/> | Component: Foo | lazy: () => import('字面量'),
 *       children: [...] }
 *   - JSX 形态：<Routes><Route path="..." element={<Foo/>}>（嵌套 Route 构成父链）
 * 路由模块定位：import react-router(-dom) 且调用 create*Router 或含 <Routes>/<Route> JSX 的模块；
 * 找不到唯一候选时返回空映射并写 gaps，不按目录名猜测。
 * 动态 path（含 :param/*）原样保留；只能作为候选的导航上下文。
 */
import ts from 'typescript'
import { join, relative, sep } from 'node:path'
import { readProjectText } from '../../../shared/profile.ts'
import { readReactBuildConfig } from '../readonly-config.ts'
import { buildModuleGraph, resolveModuleSpecifier } from './module-graph.ts'
import type { ModuleGraph } from './module-graph.ts'

export interface RouteEntry {
  /** 完整路径（父子已拼接）。 */
  path: string
  /** 相对应用根的组件文件。 */
  component: string
  /** path 是否含动态段（:id、*）。 */
  dynamic: boolean
  /** 静态父布局链：祖先路由组件文件，最外层在前；无静态父组件时为空。 */
  ancestors: string[]
}

export interface RouteMap {
  routes: RouteEntry[]
  routerModule?: string
  gaps: string[]
}

interface ModuleAst {
  bindings: Map<string, { specifier: string, imported: string }>
  arrays: Map<string, ts.ArrayLiteralExpression>
  defaultArray?: ts.ArrayLiteralExpression
  /** create*Router(...) 的首参数表达式。 */
  routerArgs: ts.Expression[]
  /** <Routes> JSX 元素。 */
  routesElements: ts.JsxElement[]
}

const toRel = (appRoot: string, file: string) => relative(appRoot, file).split(sep).join('/')
const ROUTER_PACKAGES = ['react-router-dom', 'react-router']
const DATA_ROUTER_FNS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter'])

function moduleAst(rel: string, source: string): ModuleAst {
  const tree = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/i.test(rel) ? ts.ScriptKind.TSX
      : /\.[cm]?ts$/i.test(rel) ? ts.ScriptKind.TS
      : /\.jsx$/i.test(rel) ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
  const ast: ModuleAst = { bindings: new Map(), arrays: new Map(), routerArgs: [], routesElements: [] }
  const record = (name: ts.BindingName | undefined, specifier: string, imported: string) => {
    if (name && ts.isIdentifier(name)) ast.bindings.set(name.text, { specifier, imported })
  }
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.importClause) {
      const specifier = statement.moduleSpecifier.text
      record(statement.importClause.name, specifier, 'default')
      const named = statement.importClause.namedBindings
      if (named && ts.isNamespaceImport(named)) record(named.name, specifier, '*')
      if (named && ts.isNamedImports(named)) for (const element of named.elements)
        record(element.name, specifier, element.propertyName?.text ?? element.name.text)
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
      if (ts.isIdentifier(declaration.name) && declaration.initializer
        && ts.isArrayLiteralExpression(declaration.initializer))
        ast.arrays.set(declaration.name.text, declaration.initializer)
    if (ts.isExportAssignment(statement) && !statement.isExportEquals
      && ts.isArrayLiteralExpression(statement.expression)) ast.defaultArray = statement.expression
  }
  const isRouterBinding = (name: string | undefined, imported: string | undefined) => {
    if (name === undefined) return false
    const binding = ast.bindings.get(name)
    return binding !== undefined && ROUTER_PACKAGES.includes(binding.specifier)
      && (imported === undefined || binding.imported === imported)
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0] !== undefined) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text : undefined
      if (name !== undefined && DATA_ROUTER_FNS.has(name) && isRouterBinding(name, name)) {
        ast.routerArgs.push(node.arguments[0])
      }
    }
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName
      if (ts.isIdentifier(tag) && tag.text === 'Routes' && isRouterBinding('Routes', 'Routes')) {
        ast.routesElements.push(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return ast
}

function childPath(parent: string, child: string): string {
  const joined = child.startsWith('/') ? child : (parent.replace(/\/+$/, '') + '/' + child)
  return joined.replace(/\/{2,}/g, '/')
}

const DYNAMIC_SEGMENT = /[:*]/

export async function readRouteMap(appRoot: string, entry: string | undefined, graph?: ModuleGraph): Promise<RouteMap> {
  const gaps: string[] = []
  const note = (text: string) => { if (gaps.length < 50 && !gaps.includes(text)) gaps.push(text) }
  graph ??= await buildModuleGraph(appRoot)
  const config = await readReactBuildConfig(appRoot)
  const files = graph.files
  const asts = new Map<string, Promise<ModuleAst | undefined>>()
  const astOf = (rel: string) => {
    let pending = asts.get(rel)
    if (!pending) {
      pending = readProjectText(join(appRoot, rel), appRoot).then(source =>
        source === undefined ? undefined : moduleAst(rel, source))
      asts.set(rel, pending)
    }
    return pending
  }
  const resolveSpecifier = async (fromRel: string, specifier: string): Promise<string | undefined> => {
    const resolution = resolveModuleSpecifier(appRoot, fromRel, specifier, files, config)
    if (resolution.kind === 'file') return resolution.path
    if (resolution.kind === 'unresolved')
      note(fromRel + ': route component specifier "' + specifier + '" ' +
        (resolution.reason === 'opaque-alias' ? 'matches a build alias that cannot be evaluated statically'
          : 'could not be resolved to a file'))
    return undefined
  }
  const arrayFor = async (expr: ts.Expression, rel: string, depth: number)
    : Promise<{ array: ts.ArrayLiteralExpression, rel: string } | undefined> => {
    if (ts.isArrayLiteralExpression(expr)) return { array: expr, rel }
    if (depth > 2 || !ts.isIdentifier(expr)) return undefined
    const own = (await astOf(rel))?.arrays.get(expr.text)
    if (own) return { array: own, rel }
    const binding = (await astOf(rel))?.bindings.get(expr.text)
    if (binding === undefined) return undefined
    const target = await resolveSpecifier(rel, binding.specifier)
    if (target === undefined) return undefined
    const targetAst = await astOf(target)
    const array = binding.imported === 'default' || binding.imported === '*'
      ? targetAst?.defaultArray : targetAst?.arrays.get(binding.imported)
    return array === undefined ? undefined : { array, rel: target }
  }
  /** 组件表达式 → 应用内文件：标识符绑定 / JSX <Foo/> 标签绑定 / () => import('字面量')。 */
  const componentFile = async (expr: ts.Expression, rel: string): Promise<string | undefined> => {
    if (ts.isIdentifier(expr)) {
      const binding = (await astOf(rel))?.bindings.get(expr.text)
      if (binding === undefined) {
        note(rel + ': route component "' + expr.text + '" is not a static import binding')
        return undefined
      }
      return resolveSpecifier(rel, binding.specifier)
    }
    if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
      const tag = ts.isJsxElement(expr) ? expr.openingElement.tagName : expr.tagName
      const name = ts.isIdentifier(tag) ? tag.text
        : ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) ? tag.expression.text : undefined
      if (name === undefined) { note(rel + ': JSX route element tag is not a static binding'); return undefined }
      const binding = (await astOf(rel))?.bindings.get(name)
      if (binding === undefined) {
        note(rel + ': route element <' + name + '> is not a static import binding')
        return undefined
      }
      return resolveSpecifier(rel, binding.specifier)
    }
    const literals: string[] = []
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) literals.push(argument.text)
      }
      ts.forEachChild(node, collect)
    }
    collect(expr)
    if (literals.length === 1) return resolveSpecifier(rel, literals[0]!)
    if (literals.length > 1) note(rel + ': route component uses several lazy specifiers; none were resolved')
    else note(rel + ': route component shape cannot be determined statically')
    return undefined
  }
  const routes: RouteEntry[] = []
  const prop = (element: ts.ObjectLiteralExpression, name: string) => element.properties.find(value =>
    ts.isPropertyAssignment(value) && value.name
    && (ts.isIdentifier(value.name) || ts.isStringLiteralLike(value.name)) && value.name.text === name)
  const parseEntries = async (array: ts.ArrayLiteralExpression, rel: string, prefix: string, depth: number,
    ancestors: string[] = []) => {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) { note(rel + ': a route entry is not an object literal'); continue }
      const pathProp = prop(element, 'path')
      const pathValue = pathProp && ts.isPropertyAssignment(pathProp) ? pathProp.initializer : undefined
      const path = pathValue && ts.isStringLiteralLike(pathValue) ? pathValue.text : undefined
      if (path === undefined) { note(rel + ': a route path is not a string literal'); continue }
      const full = childPath(prefix, path)
      let file: string | undefined
      for (const key of ['element', 'Component', 'component', 'lazy'] as const) {
        const found = prop(element, key)
        if (found && ts.isPropertyAssignment(found)) {
          const value = found.initializer
          const inner = ts.isJsxExpression(value) && value.expression ? value.expression : value
          file = await componentFile(inner, rel)
          break
        }
      }
      if (file !== undefined)
        routes.push({ path: full, component: file, dynamic: DYNAMIC_SEGMENT.test(path), ancestors })
      const childrenProp = prop(element, 'children')
      if (childrenProp && ts.isPropertyAssignment(childrenProp)) {
        const children = await arrayFor(childrenProp.initializer, rel, depth + 1)
        if (children) await parseEntries(children.array, children.rel, full, depth + 1,
          file === undefined ? ancestors : [...ancestors, file])
        else note(rel + ': route children of ' + JSON.stringify(full) + ' are not a static array')
      }
    }
  }
  const parseJsxRoutes = async (container: ts.JsxElement, rel: string, prefix: string,
    ancestors: string[] = []): Promise<void> => {
    for (const child of container.children) {
      if (!ts.isJsxElement(child) && !ts.isJsxSelfClosingElement(child)) continue
      const tag = ts.isJsxElement(child) ? child.openingElement.tagName : child.tagName
      const tagName = ts.isIdentifier(tag) ? tag.text : undefined
      if (tagName !== 'Route') continue
      const attributes = ts.isJsxElement(child) ? child.openingElement.attributes : child.attributes
      let path: string | undefined
      let elementExpr: ts.Expression | undefined
      for (const attribute of attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue
        const name = attribute.name.getText()
        if (name === 'path' && attribute.initializer && ts.isStringLiteralLike(attribute.initializer))
          path = attribute.initializer.text
        if ((name === 'element' || name === 'Component') && attribute.initializer
          && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
          elementExpr = attribute.initializer.expression
        }
      }
      if (path === undefined) { note(rel + ': a <Route> path is not a string literal'); continue }
      const full = childPath(prefix, path)
      const file = elementExpr === undefined ? undefined : await componentFile(elementExpr, rel)
      if (file !== undefined)
        routes.push({ path: full, component: file, dynamic: DYNAMIC_SEGMENT.test(path), ancestors })
      if (ts.isJsxElement(child)) {
        await parseJsxRoutes(child, rel, full, file === undefined ? ancestors : [...ancestors, file])
      }
    }
  }
  // 路由模块候选：图的裸说明符中含 react-router(-dom) 的文件。
  const candidates = [...graph.bareSpecifiers.entries()]
    .filter(([, specifiers]) => specifiers.some(value => ROUTER_PACKAGES.includes(value)
      || ROUTER_PACKAGES.some(pkg => value.startsWith(pkg + '/'))))
    .map(([rel]) => rel)
  const holder: Array<{ rel: string, ast: ModuleAst }> = []
  for (const rel of candidates) {
    const ast = await astOf(rel)
    if (ast && (ast.routerArgs.length || ast.routesElements.length)) holder.push({ rel, ast })
  }
  let chosen = holder
  if (chosen.length > 1 && entry !== undefined) {
    const entryRel = toRel(appRoot, entry)
    const reachable = new Set<string>([entryRel])
    const queue = [entryRel]
    while (queue.length) for (const next of graph.imports.get(queue.shift()!) ?? [])
      if (!reachable.has(next)) { reachable.add(next); queue.push(next) }
    const narrowed = chosen.filter(value => reachable.has(value.rel))
    if (narrowed.length === 1) chosen = narrowed
  }
  if (!chosen.length) {
    note(candidates.length
      ? 'No module importing react-router creates a router with a static options object'
      : 'No module importing react-router was found in the static dependency graph')
    return { routes: [], gaps }
  }
  if (chosen.length > 1) {
    note('Several modules create routers (' + chosen.map(value => value.rel).join(', ')
      + '); the route map is ambiguous and was not applied')
    return { routes: [], gaps }
  }
  const { rel, ast } = chosen[0]!
  for (const arg of ast.routerArgs) {
    const found = await arrayFor(arg, rel, 0)
    if (!found) { note(rel + ': router routes binding is not a static array literal'); continue }
    await parseEntries(found.array, found.rel, '', 0)
  }
  for (const element of ast.routesElements) await parseJsxRoutes(element, rel, '')
  routes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { routes, routerModule: rel, gaps }
}
