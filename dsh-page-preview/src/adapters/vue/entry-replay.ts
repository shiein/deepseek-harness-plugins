/**
 * 入口注册重放（方案 §6.3、§6.9、§0.3 第 10 条）。只读 JS/TS/JSX AST，不加载入口或项目配置。
 * 第三方与业务注册（use/component/directive/全局属性/样式与副作用导入）都进草稿；业务路由在运行时换成
 * 无守卫的空路由。createApp 包在顶层初始化函数里时整体搬运其顶层调用链：传递调用初始化器的顶层函数
 * 与顶层调用语句原样保留（登录/接口前置流程按入口执行，网络仍由 mock-only 控制；R5-1d），
 * 链上搬不动的成员如实诊断并回退为只跑初始化器。动态/条件/多根注册仍要求手写 setup。
 * 原始表达式仅用于本地草稿，不应放入诊断或模型可见工具结果；本模块不保存或批准 setup。
 */
import ts from 'typescript'
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseScriptSource } from '../../shared/javascript.ts'
import { isWithinRoot, resolveProjectPath } from '../../shared/config/paths.ts'
import { projectDependencyNames, readProjectManifest, readProjectText } from '../../shared/profile.ts'
import { readVueBuildConfig, unwrap } from './readonly-config.ts'
import type { ReadonlyBuildConfig } from './readonly-config.ts'
import type { VueMajor } from './detect.ts'

export type RegistrationKind = 'use' | 'component' | 'directive' | 'global-property' | 'style-import' | 'root-option' | 'side-effect-import'
type Origin = 'third-party' | 'business' | 'unresolved'
interface ImportBinding { local: string; imported: string }
interface DraftImport { source: string; resolvedSource: string; bindings: ImportBinding[]; position: number }
interface DraftDeclaration { name: string; source: string; position: number }
interface ReplayOperation {
  receiver: 'framework' | 'global' | 'root'
  key: string
  expression: string
  imports: string[]
  declarations: string[]
  position: number
}
export interface EntryRegistration {
  kind: RegistrationKind
  source: string
  imported?: string
  argsText?: string
  optionKey?: string
  origin: Origin
  location: { file: string; line: number }
  /** 本地草稿数据，不是可执行批准，也不应通过工具输出。 */
  replay?: ReplayOperation
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
    frameworks: Array<'2' | '3'>
    /** 项目依赖里有 vue-router：草稿在运行时把业务路由实例换成无守卫的空路由。 */
    routerAvailable: boolean
    /**
     * createApp 所在顶层初始化函数的搬运体（已替换 createApp、去掉 mount）；引用的导入/常量同列。
     * R5-1d：chain 为传递调用初始化器的其他顶层函数（登录/接口前置流程按入口原样保留），
     * tail 为顶层调用语句（链内调用已注入 await）；chainSkipped 记录搬不动而被丢弃的链成员。
     */
    transplant?: { name: string, line: number, source: string, imports: string[], declarations: string[],
      chain?: Array<{ name: string, line: number, source: string, imports: string[], declarations: string[] }>,
      tail?: string[], chainSkipped?: string[] }
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

/** 正则/非字面量替换的别名：命中者属于项目自定义解析，保留原说明符交给项目构建器在运行时解析。 */
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
  const aliases = config.aliases.filter(alias => specifier === alias.find
    || specifier.startsWith(alias.find + '/'))
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

/**
 * 说明符 → 规范身份：相对说明符解析为 import 方文件目录下的绝对路径，本地别名按构建配置替换到
 * 应用根，三方包与 opaque 别名保留原说明符，无法判定时返回 undefined。
 * 入口重放与「已配置 setup 是否漏掉入口样式」核对共用同一套规则（任务 C，2026-11-03）。
 */
export function resolveModuleSpecifier(config: ReadonlyBuildConfig, dependencies: ReadonlySet<string>,
  root: string, importerFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('.')) return resolve(dirname(importerFile), specifier)
  if (opaqueSpecifier(config, specifier)) return specifier
  const alias = config.aliases.find(alias => specifier === alias.find
    || specifier.startsWith(alias.find + '/'))
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
  if (source === undefined) throw new Error('Vue entry is missing')
  const result: EntryReplayResult = { entryFile: file, registrations: [], diagnostics: [], invalid: false,
    draft: { imports: [], declarations: [], identifiers: [], frameworks: [], routerAvailable: false } }
  if (parseScriptSource(file, source).invalid) {
    result.invalid = true; result.diagnostics.push('Entry syntax is invalid; no replay draft can be generated'); return result
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX)
  const config = await readVueBuildConfig(root)
  result.diagnostics.push(...config.unresolved)
  const dependencies = new Set(projectDependencyNames(await readProjectManifest(join(root, 'package.json'), root), join(root, 'package.json')))
  result.draft.routerAvailable = dependencies.has('vue-router')
  // 正则/非字面量替换的别名：命中者属于项目自定义解析，草稿保留原说明符交给项目构建器在运行时解析。
  const opaque = (specifier: string) => opaqueSpecifier(config, specifier)
  const imports = new Map<string, { item: DraftImport; imported: string }>()
  const constants = new Map<string, ts.VariableDeclaration>()
  const unsafe = new Set<string>()
  const names = new Set<string>()
  const collectNames = (node: ts.Node) => { if (ts.isIdentifier(node)) names.add(node.text); ts.forEachChild(node, collectNames) }
  collectNames(tree)
  result.draft.identifiers = [...names]
  const originOf = (specifier: string): Origin => specifierOrigin(config, dependencies, specifier)
  const resolvedSource = (specifier: string): string | undefined =>
    resolveModuleSpecifier(config, dependencies, root, file, specifier)
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      const specifier = statement.moduleSpecifier.text
      const item: DraftImport = { source: specifier, resolvedSource: resolvedSource(specifier) ?? specifier, bindings: [], position: statement.end }
      const add = (local: string, imported: string) => {
        if (imports.has(local)) unsafe.add(local)
        item.bindings.push({ local, imported }); imports.set(local, { item, imported })
      }
      const clause = statement.importClause
      if (clause?.name) add(clause.name.text, 'default')
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) add(named.name.text, '*')
      if (named && ts.isNamedImports(named)) for (const element of named.elements) if (!element.isTypeOnly) add(element.name.text, element.propertyName?.text ?? element.name.text)
      // import { type Foo } 不引入运行时模块。
      if (!clause || item.bindings.length) result.draft.imports.push(item)
    }
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) {
      if (constants.has(declaration.name.text) || imports.has(declaration.name.text)) unsafe.add(declaration.name.text)
      constants.set(declaration.name.text, declaration)
    }
  }
  const baseName = (input: ts.Node): string | undefined => {
    const node = unwrap(input)
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return baseName(node.expression)
    return undefined
  }
  const mutations = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const name = baseName(node.left)
      if (name) unsafe.add(name)
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      const name = baseName(node.operand)
      if (name) unsafe.add(name)
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = baseName(node.expression.expression)
      // 调用对象的方法可能修改该对象；不能只复制 const 的初始字面量。
      if (name && constants.has(name)) unsafe.add(name)
    }
    ts.forEachChild(node, mutations)
  }
  mutations(tree)
  const analyze = (input: ts.Node, seen = new Set<string>()): Dependencies => {
    const node = unwrap(input)
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return empty()
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined' && !constants.has(node.text) && !imports.has(node.text)) return empty()
      if (unsafe.has(node.text) || seen.has(node.text)) return unknown()
      const binding = imports.get(node.text)
      if (binding) return { sources: new Set([binding.item.source]), imports: new Set([node.text]), declarations: new Set(), unknown: false }
      const declaration = constants.get(node.text)
      if (!declaration?.initializer) return unknown()
      const value = analyze(declaration.initializer, new Set([...seen, node.text]))
      value.declarations.add(node.text)
      return value
    }
    if (ts.isPropertyAccessExpression(node)) return analyze(node.expression, seen)
    if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) return analyze(node.expression, seen)
    if (ts.isArrayLiteralExpression(node)) return merge(...node.elements.map(value => analyze(value, seen)))
    if (ts.isObjectLiteralExpression(node)) return merge(...node.properties.map(value => {
      if (ts.isPropertyAssignment(value) && (ts.isIdentifier(value.name) || ts.isStringLiteralLike(value.name) || ts.isNumericLiteral(value.name))) return analyze(value.initializer, seen)
      if (ts.isShorthandPropertyAssignment(value) && !value.objectAssignmentInitializer) return analyze(value.name, seen)
      return unknown()
    }))
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.ExclamationToken].includes(node.operator)) return analyze(node.operand, seen)
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = analyze(node.expression, seen)
      if (!callee.sources.size || callee.unknown || [...callee.sources].some(value => originOf(value) !== 'third-party' || value === 'vue')) return unknown()
      return merge(callee, ...(node.arguments ?? []).map(value => analyze(value, seen)))
    }
    return unknown()
  }
  const classify = (value: Dependencies): Origin => value.unknown || [...value.sources].some(source => originOf(source) === 'unresolved') ? 'unresolved'
    : [...value.sources].some(source => originOf(source) === 'business') || !value.sources.size ? 'business' : 'third-party'
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
  const unconditional = (input: ts.Node) => {
    let node = input
    while (node.parent && !ts.isSourceFile(node.parent)) {
      const parent = node.parent
      if (ts.isExpressionStatement(parent) || ts.isVariableStatement(parent) || ts.isVariableDeclarationList(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) { node = parent; continue }
      if (ts.isVariableDeclaration(parent) && parent.initializer === node || ts.isPropertyAccessExpression(parent) && parent.expression === node || ts.isCallExpression(parent) && parent.expression === node || ts.isBinaryExpression(parent) && parent.right === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) { node = parent; continue }
      return false
    }
    return true
  }
  const vue2 = new Set([...imports].filter(([, value]) => value.item.source === 'vue' && value.imported === 'default').map(([name]) => name))
  const isVue3Create = (node: ts.Node) => {
    node = unwrap(node)
    if (ts.isIdentifier(node)) { const binding = imports.get(node.text); return binding?.item.source === 'vue' && binding.imported === 'createApp' }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === 'createApp') { const binding = imports.get(node.expression.text); return binding?.item.source === 'vue' && binding.imported === '*' }
    return false
  }
  const creates: ts.CallExpression[] = []
  const wrapped: ts.CallExpression[] = []
  let vue2Roots = 0
  const collectCreates = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && vue2.has(node.expression.text) && unconditional(node)) vue2Roots++
    if (ts.isCallExpression(node) && isVue3Create(node.expression)) {
      if (unconditional(node)) creates.push(node)
      else wrapped.push(node)
    }
    ts.forEachChild(node, collectCreates)
  }
  collectCreates(tree)
  // 唯一的 createApp 位于顶层初始化函数内（如 async function initVue()）时整体搬运该函数体。
  if (!creates.length && wrapped.length === 1 && !vue2.size) {
    const moved = transplantInitializer(wrapped[0]!, { tree, imports, constants, unsafe, line })
    if ('reason' in moved) result.diagnostics.push(moved.reason)
    else {
      result.draft.transplant = moved
      for (const skipped of moved.chainSkipped ?? []) result.diagnostics.push('Not replayed: ' + skipped)
    }
  } else {
    for (const node of wrapped) {
      result.diagnostics.push('Conditional or wrapped Vue application at line ' + line(node) + ' requires manual setup')
    }
  }
  const apps = new Map<string, ts.CallExpression>()
  const creator = (input: ts.Node): ts.CallExpression | undefined => {
    const node = unwrap(input)
    if (ts.isCallExpression(node) && creates.includes(node)) return node
    if (ts.isIdentifier(node)) return apps.get(node.text)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['use', 'component', 'directive', 'mount'].includes(node.expression.name.text)) return creator(node.expression.expression)
    return undefined
  }
  for (const [name, declaration] of constants) if (declaration.initializer) { const value = creator(declaration.initializer); if (value) apps.set(name, value) }
  const receiver = (input: ts.Node): '2' | '3' | undefined => {
    const node = unwrap(input)
    if (ts.isIdentifier(node) && vue2.has(node.text)) return '2'
    if (creator(node)) return '3'
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['use', 'component', 'directive'].includes(node.expression.name.text)) return receiver(node.expression.expression)
    return undefined
  }
  const escapedArguments = (node: ts.Node) => {
    if (ts.isCallExpression(node) && !(ts.isPropertyAccessExpression(node.expression) && ['use', 'component', 'directive'].includes(node.expression.name.text) && receiver(node.expression.expression))) {
      const visit = (value: ts.Node) => { if (ts.isIdentifier(value) && constants.has(value.text)) unsafe.add(value.text); ts.forEachChild(value, visit) }
      node.arguments.forEach(visit)
    }
    ts.forEachChild(node, escapedArguments)
  }
  escapedArguments(tree)
  const frameworks = new Set<'2' | '3'>()
  if (vue2.size) frameworks.add('2')
  if (creates.length || result.draft.transplant) frameworks.add('3')
  if (!frameworks.size) result.diagnostics.push('Vue framework binding cannot be resolved; manual setup is required')
  result.draft.frameworks = [...frameworks]
  const ambiguous = creates.length > 1 || frameworks.size > 1
  if (ambiguous) result.diagnostics.push('Several Vue root applications/frameworks require explicit manual setup')
  if (vue2Roots > 1) result.diagnostics.push('Several Vue 2 roots require manual selection of root options; global registrations remain shared')
  const add = (node: ts.Node, kind: RegistrationKind, value: Dependencies, expression: string, key: string, valid = true) => {
    const sources = [...value.sources]
    const first = [...value.imports].map(name => imports.get(name)).find(Boolean)
    const eligible = valid && unconditional(node) && !ambiguous && originOf('vue') === 'third-party'
      && classify(value) !== 'unresolved'
    const origin = valid && unconditional(node) && !ambiguous ? classify(value) : 'unresolved'
    result.registrations.push({ kind, source: sources[0] ?? '', ...(first ? { imported: first.imported } : {}), argsText: expression,
      ...(kind === 'root-option' ? { optionKey: key } : {}), origin, location: { file, line: line(node) },
      ...(eligible ? { replay: { receiver: kind === 'root-option' ? 'root' as const : kind === 'global-property' ? 'global' as const : 'framework' as const, key, expression, imports: [...value.imports], declarations: [...value.declarations], position: node.end } } : {}),
    })
    if (!eligible) result.diagnostics.push('Entry ' + kind + ' at line ' + line(node) + ' requires manual setup (' + origin + ')')
  }
  for (const item of result.draft.imports) {
    const declaration = tree.statements.find(node => node.end === item.position)!
    if (style(item.source)) {
      const resolved = resolvedSource(item.source)
      const projectResolved = opaque(item.source)
      const local = !projectResolved && resolved && isAbsolute(resolved)
        ? await resolveProjectPath(root, relative(root, resolved) || '.').catch(() => undefined) : undefined
      const available = projectResolved || (local ? await readProjectText(local, root) !== undefined
        : originOf(item.source) === 'third-party')
      const eligible = resolved !== undefined && available && !config.aliasesUnknown
      if (resolved) item.resolvedSource = local ?? resolved
      result.registrations.push({ kind: 'style-import', source: item.source, origin: eligible ? originOf(item.source) : 'unresolved', location: { file, line: line(declaration) },
        ...(eligible ? { replay: { receiver: 'root', key: '', expression: '', imports: ['@style:' + item.position], declarations: [], position: declaration.end } } : {}),
      })
      if (!eligible) result.diagnostics.push('Entry style import at line ' + line(declaration) + ' requires manual setup')
    } else if (!item.bindings.length) {
      // 副作用导入（polyfill 等）按原顺序重放；来源无法判定时仍需手写。
      const origin = originOf(item.source)
      const resolved = resolvedSource(item.source)
      if (resolved) item.resolvedSource = resolved
      const eligible = origin !== 'unresolved' && resolved !== undefined && !config.aliasesUnknown
      const replay = { receiver: 'root' as const, key: '', expression: '', imports: ['@style:' + item.position],
        declarations: [], position: declaration.end }
      result.registrations.push({ kind: 'side-effect-import', source: item.source, origin,
        location: { file, line: line(declaration) }, ...(eligible ? { replay } : {}) })
      if (!eligible) {
        result.diagnostics.push('Entry side-effect import at line ' + line(declaration) + ' requires manual setup')
      }
    }
  }
  const visit = (node: ts.Node) => {
    // 内层链式注册先重放，保持 app.use(A).use(B) 的顺序。
    ts.forEachChild(node, visit)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['use', 'component', 'directive'].includes(node.expression.name.text)) {
      const framework = receiver(node.expression.expression)
      if (framework) {
        const args = node.arguments.map(value => value.getText(tree)).join(', ')
        const valid = node.arguments.length > 0 && !node.questionDotToken && !node.expression.questionDotToken
        add(node, node.expression.name.text as 'use' | 'component' | 'directive', merge(...node.arguments.map(value => analyze(value))), args, node.expression.name.text, valid)
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const path = node.left.expression
      const framework = ts.isPropertyAccessExpression(path) && path.name.text === 'prototype' ? receiver(path.expression)
        : ts.isPropertyAccessExpression(path) && path.name.text === 'globalProperties' && ts.isPropertyAccessExpression(path.expression) && path.expression.name.text === 'config' ? receiver(path.expression.expression) : undefined
      if (framework) add(node, 'global-property', analyze(node.right), node.right.getText(tree), node.left.name.text)
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && vue2.has(node.expression.text)) {
      const options = node.arguments?.[0]
      if (!options) return
      const object = unwrap(options)
      if (!ts.isObjectLiteralExpression(object)) { add(node, 'root-option', unknown(), '', '<dynamic>'); return }
      for (const item of object.properties) {
        if (!(ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) || !ts.isIdentifier(item.name) && !ts.isStringLiteralLike(item.name)) { add(node, 'root-option', unknown(), '', '<dynamic>'); continue }
        const key = item.name.text
        // 根组件/生命周期来自目标本身，不从原 App 复制；其余选项按同一来源规则判断。
        if (['el', 'render', 'template'].includes(key)) continue
        const value = ts.isPropertyAssignment(item) ? item.initializer : item.name
        add(node, 'root-option', analyze(value), value.getText(tree), key, vue2Roots <= 1)
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) result.diagnostics.push('Dynamic entry import at line ' + line(node) + ' requires manual setup')
  }
  visit(tree)
  const selected = new Set([...result.registrations.flatMap(value => value.replay?.declarations ?? []),
    ...(result.draft.transplant?.declarations ?? [])])
  for (const [name, declaration] of constants) if (selected.has(name)) {
    result.draft.declarations.push({ name, source: 'const ' + declaration.getText(tree), position: declaration.end })
  }
  result.registrations.sort((a, b) => a.location.line - b.location.line || (a.replay?.position ?? 0) - (b.replay?.position ?? 0))
  return result
}

interface TransplantContext {
  tree: ts.SourceFile
  imports: Map<string, { item: DraftImport; imported: string }>
  constants: Map<string, ts.VariableDeclaration>
  unsafe: Set<string>
  line(node: ts.Node): number
}
type Transplant = NonNullable<EntryReplayResult['draft']['transplant']>
const FRAMEWORK_PLACEHOLDER = '__DSH_PREVIEW_FRAMEWORK__'

type Initializer = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression
const isFunctionNode = (node: ts.Node | undefined): node is Initializer =>
  !!node && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))

interface TransplantPiece {
  name: string
  line: number
  /** 改写后的函数体文本（createApp→预览 app 占位、去 mount、链内调用注入 await）。 */
  source: string
  imports: string[]
  declarations: string[]
}

/**
 * 顶层初始化链搬运（R5-1d）：createApp(...) 换成预览 app 占位、mount(...) 去掉，
 * 并沿入口顶层调用链保留原业务流程——传递调用初始化器的顶层函数一并搬运，
 * 顶层调用语句原样保留（对链内调用注入 await 保证登录先于初始化的顺序）。
 * 只接受顶层函数声明或顶层 const/let 函数表达式；createApp 必须在初始化器函数体的无条件语句上。
 * 函数体引用的自由标识符只能是入口导入、可安全复制的顶层 const、全局对象或同被搬运的链内函数；
 * 引用其他入口内声明则放弃该片段——链上搬不动的函数/语句如实诊断并回退为只跑初始化器。
 */
function transplantInitializer(call: ts.CallExpression, ctx: TransplantContext): Transplant | { reason: string } {
  const at = ctx.line(call)
  const fail = (why: string) => ({ reason: 'Wrapped Vue application at line ' + at + ' requires manual setup: ' + why })
  let fn: ts.Node | undefined = call.parent
  while (fn && !isFunctionNode(fn)) fn = fn.parent
  if (!isFunctionNode(fn)) return fail('no initializer function')
  const owner = ts.isFunctionDeclaration(fn) ? fn : fn.parent
  const topLevel = ts.isFunctionDeclaration(fn) ? ts.isSourceFile(fn.parent)
    : ts.isVariableDeclaration(owner) && ts.isVariableDeclarationList(owner.parent)
      && ts.isVariableStatement(owner.parent.parent) && ts.isSourceFile(owner.parent.parent.parent)
  const body = fn.body
  if (!topLevel || !body || !ts.isBlock(body)) {
    return fail('the initializer is not a top-level function with a block body')
  }
  const name = ts.isFunctionDeclaration(fn) ? fn.name?.text ?? 'initializer'
    : ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) ? owner.name.text : 'initializer'
  // createApp 到函数体语句之间只能是声明/赋值/链式调用，不能在条件或循环里。
  for (let node: ts.Node = call; node.parent !== body; node = node.parent) {
    const parent = node.parent
    const wrapper = ts.isExpressionStatement(parent) || ts.isVariableStatement(parent)
      || ts.isVariableDeclarationList(parent) || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
      || ts.isNonNullExpression(parent) || ts.isAwaitExpression(parent)
    const flow = ts.isVariableDeclaration(parent) && parent.initializer === node
      || ts.isPropertyAccessExpression(parent) && parent.expression === node
      || ts.isCallExpression(parent) && parent.expression === node
      || ts.isBinaryExpression(parent) && parent.right === node
        && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    const passthrough = wrapper || flow
    if (!passthrough) return fail('createApp is created conditionally inside ' + name + '()')
  }

  // 顶层函数表与调用链：chain = 初始化器及传递调用它的顶层函数（先登录后 initVue 的项目形态）。
  const topFunctions = new Map<string, ts.FunctionDeclaration | ts.VariableDeclaration>()
  for (const statement of ctx.tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) topFunctions.set(statement.name.text, statement)
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionNode(decl.initializer)) {
          topFunctions.set(decl.name.text, decl)
        }
      }
    }
  }
  const fnBodyOf = (decl: ts.FunctionDeclaration | ts.VariableDeclaration): ts.Block | undefined => {
    const value: ts.Node | undefined = ts.isFunctionDeclaration(decl) ? decl : decl.initializer
    if (value === undefined || !isFunctionNode(value)) return undefined
    return value.body !== undefined && ts.isBlock(value.body) ? value.body : undefined
  }
  const chainCalls = (scope: ts.Node): Set<string> => {
    const found = new Set<string>()
    const seek = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && topFunctions.has(node.expression.text)) found.add(node.expression.text)
      ts.forEachChild(node, seek)
    }
    seek(scope)
    return found
  }
  const chain = new Set<string>([name])
  let grew = true
  while (grew) {
    grew = false
    for (const [candidate, decl] of topFunctions) {
      const scope = fnBodyOf(decl)
      if (!chain.has(candidate) && scope !== undefined
        && [...chainCalls(scope)].some(target => chain.has(target))) { chain.add(candidate); grew = true }
    }
  }

  const declare = (node: ts.Node, locals: Set<string>) => {
    const bind = (binding: ts.BindingName) => {
      if (ts.isIdentifier(binding)) { locals.add(binding.text); return }
      for (const element of binding.elements) if (!ts.isOmittedExpression(element)) bind(element.name)
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) bind(node.name)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) locals.add(node.name.text)
    if (ts.isCatchClause(node) && node.variableDeclaration) bind(node.variableDeclaration.name)
    ts.forEachChild(node, child => declare(child, locals))
  }

  /** 单段源码搬运：返回改写后文本与外部依赖；失败给出 blocked 原因。 */
  const transplantScope = (scope: ts.Node, start: number, end: number, localNames: Set<string>,
    allowed: ReadonlySet<string>, label: string,
  ): { source: string; imports: string[]; declarations: string[] } | { blocked: string } => {
    const edits: Array<{ start: number; end: number; text: string }> = []
    const imports = new Set<string>()
    const declarations = new Set<string>()
    const visiting = new Set<string>()
    let blocked: string | undefined
    const reference = (id: ts.Identifier) => {
      const text = id.text
      if (localNames.has(text) || allowed.has(text)) return
      if (ctx.imports.has(text)) { imports.add(text); return }
      const constant = ctx.constants.get(text)
      if (constant) {
        if (ctx.unsafe.has(text)) { blocked ??= 'it uses the reassigned entry constant ' + text; return }
        if (visiting.has(text)) return
        declarations.add(text)
        visiting.add(text)
        // 复制的 const 的初始化器自身可能引用入口导入（如 const token = getToken()），递归收口依赖。
        if (constant.initializer) walkRefs(constant.initializer)
        visiting.delete(text)
        return
      }
      const local = ctx.tree.statements.some(statement =>
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === text
        || ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === text))
      if (local) blocked ??= 'it calls the entry-local ' + text
    }
    const walkRefs = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent
        const isName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node
          || (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node
        if (!isName) reference(node)
        return
      }
      ts.forEachChild(node, walkRefs)
    }
    const visit = (node: ts.Node) => {
      // createApp 占位改写走同一批 edits：其参数（根组件等）不再引用，区间与其他改写不重叠。
      if (node === call) {
        edits.push({ start: node.getStart(ctx.tree), end: node.end, text: FRAMEWORK_PLACEHOLDER })
        return
      }
      const mount = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'mount'
      if (mount) {
        // 只删去 .mount(...) 后缀：与接收者内部的 createApp 改写不重叠。
        edits.push({ start: node.expression.expression.end, end: node.end, text: '' })
        visit(node.expression.expression)
        return
      }
      // 链内函数调用注入 await：预览需要登录先于初始化的确定顺序。
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && allowed.has(node.expression.text) && !ts.isAwaitExpression(node.parent)) {
        let enclosing: ts.Node | undefined = node.parent
        while (enclosing && !isFunctionNode(enclosing) && enclosing !== scope) enclosing = enclosing.parent
        if (enclosing === scope) {
          const at = node.getStart(ctx.tree)
          edits.push({ start: at, end: at, text: 'await ' })
        }
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent
        const isName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node
          || (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node
        if (!isName) reference(node)
        return
      }
      ts.forEachChild(node, visit)
    }
    // forEachChild 对 Block 直接枚举 statements；getChildren 会返回 SyntaxList 而不展开。
    ts.forEachChild(scope, visit)
    if (blocked !== undefined) return { blocked: label + ' ' + blocked }
    edits.sort((a, b) => b.start - a.start || b.end - a.end)
    let source = ctx.tree.text.slice(start, end)
    for (const edit of edits) source = source.slice(0, edit.start - start) + edit.text + source.slice(edit.end - start)
    return { source, imports: [...imports], declarations: [...declarations] }
  }

  /** 函数体内对链成员的引用（调用与非调用都算；排除局部遮蔽与属性名位置）。 */
  const refsOf = (info: { body: ts.Block; locals: Set<string> }): Set<string> => {
    const refs = new Set<string>()
    const seek = (node: ts.Node) => {
      if (ts.isIdentifier(node) && chain.has(node.text) && !info.locals.has(node.text)) {
        const parent = node.parent
        const isName = ts.isPropertyAccessExpression(parent) && parent.name === node
          || ts.isPropertyAssignment(parent) && parent.name === node
          || (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node
        if (!isName) refs.add(node.text)
      }
      ts.forEachChild(node, seek)
    }
    seek(info.body)
    return refs
  }

  const locals = new Set<string>()
  declare(fn, locals)
  const dropped = new Set<string>()
  const infos = new Map<string, { decl: ts.FunctionDeclaration | ts.VariableDeclaration
    body: ts.Block; locals: Set<string> }>()
  infos.set(name, { decl: fn as ts.FunctionDeclaration, body, locals })
  for (const [candidate, decl] of [...topFunctions].sort((a, b) => a[1].getStart(ctx.tree) - b[1].getStart(ctx.tree))) {
    if (!chain.has(candidate) || candidate === name) continue
    const scope = fnBodyOf(decl)
    if (scope === undefined) { dropped.add(candidate); continue }
    const fnNode: ts.Node = ts.isFunctionDeclaration(decl) ? decl : decl.initializer!
    const inner = new Set<string>()
    declare(fnNode, inner)
    infos.set(candidate, { decl, body: scope, locals: inner })
  }

  // 第一遍：试探搬运链上每个函数（链名相互可见）；第二遍：引用到未搬运成员的函数级联丢弃。
  const moved = new Map<string, TransplantPiece>()
  const blockedReasons = new Map<string, string>()
  for (const [candidate, info] of infos) {
    const res = transplantScope(info.body, info.body.getStart(ctx.tree) + 1, info.body.end - 1,
      info.locals, chain, 'the entry function ' + candidate + '()')
    if ('blocked' in res) { dropped.add(candidate); blockedReasons.set(candidate, res.blocked); continue }
    moved.set(candidate, { name: candidate, line: ctx.line(info.decl), source: res.source,
      imports: res.imports, declarations: res.declarations })
  }
  if (!moved.has(name)) return fail(blockedReasons.get(name) ?? 'the initializer ' + name + '() is unreplayable')
  const emitted = new Set(moved.keys())
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of [...emitted]) {
      const info = infos.get(candidate)!
      if ([...refsOf(info)].some(ref => !emitted.has(ref))) {
        emitted.delete(candidate)
        moved.delete(candidate)
        dropped.add(candidate)
        changed = true
      }
    }
  }
  if (!emitted.has(name)) return fail('the initializer ' + name + '() depends on an unreplayable entry function')
  const piece = moved.get(name)!
  const result: Transplant = {
    name, line: piece.line, source: piece.source,
    imports: piece.imports, declarations: piece.declarations,
  }
  moved.delete(name)
  const pieces = [...moved.values()].sort((a, b) => a.line - b.line)
  for (const item of pieces) {
    result.imports.push(...item.imports)
    result.declarations.push(...item.declarations)
  }

  // 顶层调用语句：含链内调用的 ExpressionStatement/IfStatement；引用不可搬运的整条丢弃。
  const tails: string[] = []
  const droppedTails: string[] = []
  for (const statement of ctx.tree.statements) {
    if (!ts.isExpressionStatement(statement) && !ts.isIfStatement(statement)) continue
    if (![...chainCalls(statement)].some(target => emitted.has(target))) continue
    const inner = new Set<string>()
    declare(statement, inner)
    const movedTail = transplantScope(statement, statement.getStart(ctx.tree), statement.end, inner, emitted,
      'the entry statement at line ' + ctx.line(statement))
    if ('blocked' in movedTail) droppedTails.push(String(ctx.line(statement)))
    else {
      tails.push(movedTail.source.trim())
      result.imports.push(...movedTail.imports)
      result.declarations.push(...movedTail.declarations)
    }
  }
  if (pieces.length) result.chain = pieces
  if (tails.length) result.tail = tails
  const skipped = [...dropped].map(candidate => 'the entry function ' + candidate + '()')
    .concat(droppedTails.map(line => 'the entry statement at line ' + line))
  if (skipped.length) result.chainSkipped = skipped
  result.imports = [...new Set(result.imports)]
  result.declarations = [...new Set(result.declarations)]
  return result
}

export interface DraftOptions {
  /** 绝对文件路径在草稿中的导入写法（插件虚拟模块里用 /@fs/）；缺省原样写出。 */
  importPath?: (file: string) => string
}

/**
 * 运行时路由替换（§0.3 第 10 条）：业务路由带登录守卫与后端动态路由，预览里换成无守卫的空路由；
 * 判定只看 vue-router 实例形状（beforeEach + addRoute(s) + currentRoute），与具体项目无关。
 */
function routerGuard(family: '2' | '3', framework: string): string[] {
  const check = 'function __previewIsRouter(value) { return !!value && typeof value === "object"'
    + ' && typeof value.beforeEach === "function" && (typeof value.addRoute === "function"'
    + ' || typeof value.addRoutes === "function") && "currentRoute" in value }'
  if (family === '2') {
    return ['    ' + check,
      '    function __previewRouter(value) { return __previewIsRouter(value)'
        + ' ? new value.constructor({ mode: "abstract", routes: [] }) : value }']
  }
  return ['    ' + check,
    '    const __previewInertRouter = await import("vue-router").then(function (router) {',
    '      return router.createRouter({ history: router.createMemoryHistory(), routes: [{ path: "/:pathMatch(.*)*",',
    '        component: { name: "DshPreviewRoute", render: function () { return null } } }] })',
    '    })',
    '    const __previewUse = ' + framework + '.use',
    '    ' + framework + '.use = function (plugin) {',
    '      const rest = Array.prototype.slice.call(arguments, 1)',
    '      return __previewUse.apply(this, [__previewIsRouter(plugin) ? __previewInertRouter : plugin].concat(rest))',
    '    }',
    '    function __previewRouter(value) { return __previewIsRouter(value) ? __previewInertRouter : value }']
}

/** 生成纯 JS/ES2018 ESM 草稿；无文件写入、无执行。插件自动使用时按执行指纹审批（§0.3 第 10 条）。 */
export function generateSetupDraft(result: EntryReplayResult, vue: VueMajor, options: DraftOptions = {}): string {
  if (result.invalid) throw new Error('Cannot generate a setup draft from invalid entry syntax')
  const family = vue === '3' ? '3' : '2'
  if (result.draft.frameworks.some(value => value !== family)) throw new Error('Entry framework differs from the requested Vue runtime')
  const names = new Set(result.draft.identifiers)
  const allocate = (prefix: string) => { let name = prefix; let index = 0; while (names.has(name)) name = prefix + ++index; names.add(name); return name }
  const framework = allocate('__previewFramework')
  const rootOptions = allocate('__previewRootOptions')
  const quote = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const js = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.ESNext } }).outputText.trim()
  // 只映射真正解析成文件系统路径的导入（相对路径、绝对替换别名）；别名/裸说明符原样交给项目构建器。
  const importPath = (item: DraftImport) => item.resolvedSource !== item.source && isAbsolute(item.resolvedSource)
    && options.importPath ? options.importPath(item.resolvedSource) : item.resolvedSource
  const importOnly = (kind: RegistrationKind) => kind === 'style-import' || kind === 'side-effect-import'
  const operations = result.registrations
    .flatMap(value => value.replay && !importOnly(value.kind) ? [value.replay] : [])
  const transplant = result.draft.transplant
  const imported = new Set([...result.registrations.flatMap(value => value.replay?.imports ?? []),
    ...(transplant?.imports ?? [])])
  const guarded = result.draft.routerAvailable
  const lines = ['// Generated by dsh-page-preview from the application entry; review before saving as runtime.setup.',
    '// Business, conditional and unresolved initialization that could not be replayed is listed below.',
    ...result.diagnostics.map(value => '// ' + value), 'export default {',
    '  async install({ ' + (family === '2' ? 'Vue' : 'app') + ': ' + framework + ' }) {',
    '    const ' + rootOptions + ' = {}',
    ...(guarded ? routerGuard(family, framework) : []), '    try {']
  for (const item of result.draft.imports) {
    const selected = item.bindings.filter(value => imported.has(value.local))
    if (!selected.length && !imported.has('@style:' + item.position)) continue
    if (!selected.length) { lines.push('    await import(' + quote(importPath(item)) + ')'); continue }
    const module = allocate('__previewModule')
    lines.push('    const ' + module + ' = await import(' + quote(importPath(item)) + ')')
    for (const binding of selected) lines.push('    const ' + binding.local + ' = ' + (binding.imported === '*' ? module : module + '[' + quote(binding.imported) + ']'))
  }
  const events: Array<{ position: number; source: string }> = result.draft.declarations.map(value => ({ position: value.position, source: js(value.source) }))
  for (const operation of operations) {
    const target = operation.receiver === 'root' ? rootOptions : operation.receiver === 'global' ? framework + (family === '2' ? '.prototype' : '.config.globalProperties') : framework
    const key = '[' + quote(operation.key) + ']'
    const expression = guarded && operation.receiver === 'root' && operation.key === 'router'
      ? '__previewRouter(' + operation.expression + ')' : operation.expression
    const statement = operation.receiver === 'framework' ? '(' + expression + ')' : ' = ' + expression
    events.push({ position: operation.position, source: js(target + key + statement) })
  }
  events.sort((a, b) => a.position - b.position)
  for (const event of events) for (const line of event.source.split('\n')) lines.push('    ' + line)
  if (transplant) {
    // 初始化链放进独立异步作用域（R5-1d）：链上函数按入口顺序命名声明，顶层调用语句原样
    // 保留（链内调用已注入 await）；createApp 占位换成预览 app。没有可搬运调用语句时直接跑初始化器。
    lines.push('    // Replayed initializer ' + transplant.name + '() from the entry (line ' + transplant.line + ')')
    const pieces = [...(transplant.chain ?? []),
      { name: transplant.name, line: transplant.line, source: transplant.source }]
    pieces.sort((a, b) => a.line - b.line)
    for (const piece of pieces) {
      const decl = ('const ' + piece.name + ' = async () => {\n' + piece.source + '\n}')
        .split(FRAMEWORK_PLACEHOLDER).join(framework)
      for (const line of js(decl).split('\n')) lines.push('    ' + line)
    }
    if (transplant.tail?.length) {
      for (const statement of transplant.tail) for (const line of js(statement).split('\n')) lines.push('    ' + line)
    } else {
      lines.push('    await ' + transplant.name + '()')
    }
  }
  const restore = guarded && family === '3' ? ['      ' + framework + '.use = __previewUse'] : []
  lines.push('    } finally {', ...restore, '    }')
  lines.push('    return { rootOptions: ' + rootOptions + ' }', '  },', '  async createContext({ installation }) { return installation },', '}', '')
  return lines.join('\n')
}
