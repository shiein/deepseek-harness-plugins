/**
 * Vue Router 路由表的只读映射：路由 path ↔ 页面组件文件（方案 §5.2、§6.6；R3 计划 R3-4）。
 *
 * 只识别静态可确定的形态，其余进 gaps：
 *   - createRouter({ routes }) / new VueRouter({ routes }) 中的 routes 数组字面量
 *   - routes 值可经同文件 const 引用或静态 import 绑定跨文件解析一跳（import { routes } / default）
 *   - 每项 { path: '字面量', component: Foo | () => import('字面量') | require('字面量'), children: [...] }
 *   - Foo 为静态 import 绑定时解析到文件
 * 路由文件的定位：import 了 vue-router 且调用 createRouter/new VueRouter 的模块；有 entry 时优先取
 * 入口可达的那个；找不到唯一路由模块时返回空映射并写 gaps，不按 src/router 目录名猜测。
 * 动态 path（含 :param/*）原样保留；它只能作为候选的导航上下文，不能直接作为可打开 route 选择器。
 *
 * 组件中立：不区分 UI 组件库；只依赖 vue-router 的公开配置形状。
 */

import ts from 'typescript'
import { join, relative, sep } from 'node:path'
import { readProjectText } from '../../../shared/profile.ts'
import { parseVueSfc } from '../../../shared/vue-sfc.ts'
import { readVueBuildConfig } from '../readonly-config.ts'
import { buildModuleGraph, resolveModuleSpecifier } from './module-graph.ts'
import type { ModuleGraph } from './module-graph.ts'

export interface RouteEntry {
  /** 完整路径（父子已拼接）。 */
  path: string
  /** 相对应用根的组件文件。 */
  component: string
  /** path 是否含动态段（:id、*）。 */
  dynamic: boolean
  /** 静态父布局链：祖先路由组件文件，最外层在前（R5-4）；无静态父组件时为空。 */
  ancestors: string[]
}

export interface RouteMap {
  routes: RouteEntry[]
  /** 路由模块（相对应用根）；未找到唯一模块时缺失。 */
  routerModule?: string
  gaps: string[]
}

interface ModuleAst {
  /** 局部名 → 来源说明符与导入名（'default'/'*' 或命名导入原名）。 */
  bindings: Map<string, { specifier: string, imported: string }>
  /** 顶层 const 数组字面量（含导出）：const routes = [...]。 */
  arrays: Map<string, ts.ArrayLiteralExpression>
  /** export default [...] 的数组字面量。 */
  defaultArray?: ts.ArrayLiteralExpression
  /** createRouter({...}) / new VueRouter({...}) 的首个对象字面量参数。 */
  routerOptions: ts.ObjectLiteralExpression[]
}

const toRel = (appRoot: string, file: string) => relative(appRoot, file).split(sep).join('/')

function moduleAst(rel: string, source: string): ModuleAst {
  const tree = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true,
    /\.tsx$/i.test(rel) ? ts.ScriptKind.TSX
      : /\.[cm]?ts$/i.test(rel) ? ts.ScriptKind.TS
      : /\.jsx$/i.test(rel) ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
  const ast: ModuleAst = { bindings: new Map(), arrays: new Map(), routerOptions: [] }
  const record = (name: ts.BindingName | undefined, specifier: string, imported: string) => {
    if (name && ts.isIdentifier(name)) ast.bindings.set(name.text, { specifier, imported })
  }
  const literal = (node: ts.Node | undefined): ts.ArrayLiteralExpression | undefined =>
    node !== undefined && ts.isArrayLiteralExpression(node) ? node : undefined
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
      if (ts.isIdentifier(declaration.name)) {
        const array = literal(declaration.initializer)
        if (array) ast.arrays.set(declaration.name.text, array)
      }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const array = literal(statement.expression)
      if (array) ast.defaultArray = array
    }
  }
  // routerOptions 收集：callee 名字解析到 'vue-router' 的调用/构造，参数为对象字面量。
  const visit = (node: ts.Node) => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0] !== undefined) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text
        : undefined
      const specifier = name === undefined ? undefined : ast.bindings.get(name)?.specifier
      if (specifier === 'vue-router' || specifier?.startsWith('vue-router/')) {
        const option = node.arguments[0]
        if (ts.isObjectLiteralExpression(option)) ast.routerOptions.push(option)
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

/**
 * routes 表达式 → 数组字面量：数组字面量 / 同文件 const / 经 import 绑定的跨文件导出。
 * 跨文件只解析一跳并限深，防止环。
 */
export async function readRouteMap(appRoot: string, entry: string | undefined, graph?: ModuleGraph): Promise<RouteMap> {
  const gaps: string[] = []
  const note = (text: string) => { if (gaps.length < 50 && !gaps.includes(text)) gaps.push(text) }
  graph ??= await buildModuleGraph(appRoot)
  const config = await readVueBuildConfig(appRoot)
  const files = graph.files
  const asts = new Map<string, Promise<ModuleAst | undefined>>()
  const astOf = (rel: string) => {
    let pending = asts.get(rel)
    if (!pending) {
      pending = readProjectText(join(appRoot, rel), appRoot).then(source => {
        if (source === undefined) return undefined
        // .vue 路由模块只解析其首个 <script> 块；整块 SFC 不是合法 TS。
        if (/\.vue$/i.test(rel)) {
          const sfc = parseVueSfc(source)
          const block = sfc.scripts.find(value => value.src === undefined)
          if (block === undefined) return undefined
          return moduleAst(rel + '.script.' + (block.lang === 'ts' ? 'ts' : 'js'), block.source)
        }
        return moduleAst(rel, source)
      })
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
  // 返回值携带数组所属模块：跨文件一跳后，数组内的组件/子路由绑定要在该模块解析。
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
    // 命名导入按导入名在目标文件里找导出 const；default/* 按 default 导出数组处理。
    const array = binding.imported === 'default' || binding.imported === '*'
      ? targetAst?.defaultArray : targetAst?.arrays.get(binding.imported)
    return array === undefined ? undefined : { array, rel: target }
  }
  /** 组件表达式 → 应用内文件；无法静态确定时记 gap 返回 undefined。 */
  const componentFile = async (expr: ts.Expression, rel: string): Promise<string | undefined> => {
    const literals: string[] = []
    const collect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteralLike(argument)) literals.push(argument.text)
      }
      ts.forEachChild(node, collect)
    }
    if (ts.isIdentifier(expr)) {
      const binding = (await astOf(rel))?.bindings.get(expr.text)
      if (binding === undefined) {
        note(rel + ': route component "' + expr.text + '" is not a static import binding')
        return undefined
      }
      return resolveSpecifier(rel, binding.specifier)
    }
    collect(expr)
    if (literals.length === 1) return resolveSpecifier(rel, literals[0]!)
    if (literals.length > 1) note(rel + ': route component uses several lazy specifiers; none were resolved')
    else note(rel + ': route component shape cannot be determined statically')
    return undefined
  }
  const routes: RouteEntry[] = []
  const parseEntries = async (array: ts.ArrayLiteralExpression, rel: string, prefix: string, depth: number,
    ancestors: string[] = []) => {
    for (const element of array.elements) {
      if (!ts.isObjectLiteralExpression(element)) { note(rel + ': a route entry is not an object literal'); continue }
      const prop = (name: string) => element.properties.find(value =>
        ts.isPropertyAssignment(value) && value.name
        && (ts.isIdentifier(value.name) || ts.isStringLiteralLike(value.name)) && value.name.text === name)
      const pathProp = prop('path')
      const pathValue = pathProp && ts.isPropertyAssignment(pathProp) ? pathProp.initializer : undefined
      const path = pathValue && ts.isStringLiteralLike(pathValue) ? pathValue.text : undefined
      if (path === undefined) { note(rel + ': a route path is not a string literal'); continue }
      const full = childPath(prefix, path)
      const componentProp = prop('component')
      let file: string | undefined
      if (componentProp && ts.isPropertyAssignment(componentProp)) {
        file = await componentFile(componentProp.initializer, rel)
        if (file !== undefined)
          routes.push({ path: full, component: file, dynamic: DYNAMIC_SEGMENT.test(path), ancestors })
      }
      const childrenProp = prop('children')
      if (childrenProp && ts.isPropertyAssignment(childrenProp)) {
        const children = await arrayFor(childrenProp.initializer, rel, depth + 1)
        if (children) await parseEntries(children.array, children.rel, full, depth + 1,
          file === undefined ? ancestors : [...ancestors, file])
        else note(rel + ': route children of ' + JSON.stringify(full) + ' are not a static array')
      }
      // redirect/alias/components 命名视图：不产生页面组件目标，保持静默（路由项其余形态不猜）。
    }
  }
  // 路由模块候选：图的裸说明符中含 vue-router 的文件。
  const candidates = [...graph.bareSpecifiers.entries()]
    .filter(([, specifiers]) => specifiers.some(value => value === 'vue-router' || value.startsWith('vue-router/')))
    .map(([rel]) => rel)
  const holder: Array<{ rel: string, ast: ModuleAst }> = []
  for (const rel of candidates) {
    const ast = await astOf(rel)
    if (ast?.routerOptions.length) holder.push({ rel, ast })
  }
  // 唯一路由模块规则；入口可收窄：entry 可达集合内恰有一个候选时采用它。
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
      ? 'No module importing vue-router creates a router with a static options object'
      : 'No module importing vue-router was found in the static dependency graph')
    return { routes: [], gaps }
  }
  if (chosen.length > 1) {
    note('Several modules create routers (' + chosen.map(value => value.rel).join(', ')
      + '); the route map is ambiguous and was not applied')
    return { routes: [], gaps }
  }
  const { rel, ast } = chosen[0]!
  for (const options of ast.routerOptions) {
    const routesProp = options.properties.find(value =>
      value.name && ts.isIdentifier(value.name) && value.name.text === 'routes')
    const value = routesProp === undefined ? undefined
      : ts.isPropertyAssignment(routesProp) ? routesProp.initializer
      : ts.isShorthandPropertyAssignment(routesProp) ? routesProp.name
      : undefined
    if (value === undefined) { note(rel + ': router options have no literal routes binding'); continue }
    const found = await arrayFor(value, rel, 0)
    if (!found) { note(rel + ': router routes binding is not a static array literal'); continue }
    await parseEntries(found.array, found.rel, '', 0)
  }
  routes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { routes, routerModule: rel, gaps }
}
