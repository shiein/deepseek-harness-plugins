/**
 * 构建入口/别名的静态读取共享实现（方案 §6.5、§6.9；F9 自 vue/react readonly-config 抽取）。
 * 仅解释明确的字面量和 Node 路径表达式，不加载配置或插件。
 * 框架差异只经 BuildConfigFlavor 传入：'vite' 读 vite.config.* 的 resolve.alias /
 * rollupOptions.input / vite-plugin-mock 调用；'cli' 读 vue.config.* 的
 * configureWebpack.resolve.alias / pages.*.entry。框架判断不出现在本模块。
 */
import ts from 'typescript'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readProjectText } from '../../shared/profile.ts'
import { parseScriptSource } from '../../shared/javascript.ts'

export interface ConfigAlias { find: string, replacement: string }
export interface ReadonlyBuildConfig {
  files: string[]
  aliases: ConfigAlias[]
  aliasesUnknown: boolean
  entries: string[]
  entryUnknown: boolean
  root?: string
  /** 配置文件静态 import/require 的模块说明符（只读事实；不代表插件实际被启用）。 */
  imports: string[]
  /**
   * 能确定「匹配范围」但替换目标无法静态求值的别名：正则字面量 find，或替换为非字面量的字符串 find。
   * 命中它们的说明符属于项目自定义解析（由项目构建器在运行时解析），未命中的说明符不受影响。
   */
  opaqueAliases: Array<{ pattern: string, flags: string } | { find: string }>
  /**
   * vite-plugin-mock 调用选项（仅 plugins 数组中对 'vite-plugin-mock' 导入符号的调用；R5-1e）。
   * 字面量可完整求值时给 { mockPath }；出现非字面量选项或多个调用时 'unresolved'，Runner 不执行。
   */
  mockPlugin?: { mockPath: string } | 'unresolved'
  unresolved: string[]
}
export const VITE_CONFIG_NAMES = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mts',
  'vite.config.mjs', 'vite.config.cts', 'vite.config.cjs',
]

/** 单个配置文件的读取口径；框架差异全部收敛在这一个参数上。 */
export type BuildConfigFlavor = 'vite' | 'cli'

export interface ReadBuildConfigOptions {
  /** 按序尝试的配置文件名（存在才解析，多于一个即记 ambiguity）。 */
  names: readonly string[]
  /** 每个文件名按其宿主判定读取口径。 */
  flavorOf(name: string): BuildConfigFlavor
}

export function unwrap(node: ts.Node): ts.Node {
  for (;;) {
    const wrapped = ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
    if (!wrapped) return node
    node = (node as ts.ParenthesizedExpression).expression
  }
}
export function property(node: ts.Node | undefined, key: string): ts.Node | undefined | 'unknown' {
  if (!node) return undefined
  node = unwrap(node)
  if (!ts.isObjectLiteralExpression(node)) return 'unknown'
  const opaque = node.properties.some(value => ts.isSpreadAssignment(value)
    || value.name && ts.isComputedPropertyName(value.name))
  if (opaque) return 'unknown'
  const values = node.properties.filter(value => value.name
    && (ts.isIdentifier(value.name) || ts.isStringLiteralLike(value.name))
    && value.name.text === key)
  if (values.length > 1) return 'unknown'
  const found = values[0]
  return found === undefined ? undefined : ts.isPropertyAssignment(found) ? found.initializer : 'unknown'
}

export async function readBuildConfig(appRoot: string,
  options: ReadBuildConfigOptions): Promise<ReadonlyBuildConfig> {
  const result: ReadonlyBuildConfig = {
    files: [], aliases: [], aliasesUnknown: false, entries: [], entryUnknown: false, imports: [], opaqueAliases: [],
    unresolved: [],
  }
  for (const name of options.names) {
    const file = join(appRoot, name)
    const source = await readProjectText(file, appRoot)
    if (source === undefined) continue
    result.files.push(file)
    if (result.files.length > 1) {
      result.aliasesUnknown = true; result.entryUnknown = true
      result.unresolved.push('Several build configuration sources require an explicit build host/configuration')
      continue
    }
    const kind = /\.[cm]?ts$/.test(name) ? ts.ScriptKind.TS : ts.ScriptKind.JS
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
    if (parseScriptSource(file, source).invalid) {
      result.entryUnknown = true; result.aliasesUnknown = true
      result.unresolved.push('Invalid build configuration syntax: ' + name)
      continue
    }
    const bindings = new Map<string, { source: string, imported: string }>()
    const constants = new Map<string, ts.Expression>()
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
        && statement.importClause && !statement.importClause.isTypeOnly) {
        const specifier = statement.moduleSpecifier.text
        if (statement.importClause.name)
          bindings.set(statement.importClause.name.text, { source: specifier, imported: 'default' })
        const named = statement.importClause.namedBindings
        if (named && ts.isNamespaceImport(named))
          bindings.set(named.name.text, { source: specifier, imported: '*' })
        if (named && ts.isNamedImports(named)) for (const element of named.elements) {
          if (!element.isTypeOnly) bindings.set(element.name.text,
            { source: specifier, imported: element.propertyName?.text ?? element.name.text })
        }
      }
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
          const value = unwrap(declaration.initializer)
          const isRequire = ts.isCallExpression(value) && ts.isIdentifier(value.expression)
            && value.expression.text === 'require' && value.arguments[0]
            && ts.isStringLiteralLike(value.arguments[0])
          if (isRequire) bindings.set(declaration.name.text,
            { source: ((value as ts.CallExpression).arguments[0] as ts.StringLiteral).text, imported: '*' })
          else constants.set(declaration.name.text, declaration.initializer)
        }
      }
    }
    for (const { source: specifier } of bindings.values()) {
      if (!result.imports.includes(specifier)) result.imports.push(specifier)
    }
    const string = (input: ts.Node, seen = new Set<string>()): string | undefined => {
      const node = unwrap(input)
      if (ts.isStringLiteralLike(node)) return node.text
      if (ts.isIdentifier(node)) {
        if (node.text === '__dirname' && !constants.has(node.text) && !bindings.has(node.text)) return dirname(file)
        if (seen.has(node.text)) return undefined
        const value = constants.get(node.text)
        if (value) return string(value, new Set([...seen, node.text]))
      }
      if (ts.isCallExpression(node)) {
        const fn = unwrap(node.expression)
        // process.cwd()：Runner 的 worker 固定以应用根为 cwd 启动（worker-host spawn cwd: appRoot），
        // 项目配置在那里执行时取值即应用根；process 被本地绑定遮蔽时不解释。
        if (ts.isPropertyAccessExpression(fn) && fn.name.text === 'cwd' && ts.isIdentifier(fn.expression)
          && fn.expression.text === 'process' && !node.arguments.length
          && !constants.has('process') && !bindings.has('process')) return appRoot
        const binding = ts.isIdentifier(fn) ? bindings.get(fn.text)
          : ts.isPropertyAccessExpression(fn) && ts.isIdentifier(fn.expression)
            ? bindings.get(fn.expression.text) : undefined
        const method = ts.isIdentifier(fn) ? binding?.imported
          : ts.isPropertyAccessExpression(fn) ? fn.name.text : undefined
        if (binding && ['path', 'node:path'].includes(binding.source) && ['resolve', 'join'].includes(method ?? '')) {
          const args = node.arguments.map(value => string(value, seen))
          // resolve('src') 依赖启动 cwd；只解释存在绝对基准的表达式。
          if (args.every((value): value is string => value !== undefined) && args.some(isAbsolute)) {
            if (method === 'resolve') return resolve(...args)
            return isAbsolute(args[0]!) ? join(...args) : undefined
          }
        }
        if (binding && ['url', 'node:url'].includes(binding.source) && method === 'fileURLToPath') {
          const argument = node.arguments[0]
          const isNewUrl = argument !== undefined && ts.isNewExpression(argument)
            && ts.isIdentifier(argument.expression) && argument.expression.text === 'URL'
            && !constants.has('URL') && !bindings.has('URL')
          if (isNewUrl) {
            const [path, base] = (argument as ts.NewExpression).arguments ?? []
            const isImportMetaUrl = base !== undefined && ts.isPropertyAccessExpression(base)
              && base.name.text === 'url' && ts.isMetaProperty(base.expression)
              && base.expression.keywordToken === ts.SyntaxKind.ImportKeyword
            if (path && ts.isStringLiteralLike(path) && isImportMetaUrl) {
              try {
                const url = new URL(path.text, pathToFileURL(file))
                if (url.protocol === 'file:') return fileURLToPath(url)
              } catch { return undefined } // 字面量 URL 无效，不执行项目表达式来补算。
            }
          }
        }
      }
      return undefined
    }
    let config: ts.Node | undefined
    for (const statement of tree.statements) {
      const isExportsAssign = ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && statement.expression.left.getText(tree) === 'module.exports'
      let value = ts.isExportAssignment(statement) && !statement.isExportEquals ? unwrap(statement.expression)
        : isExportsAssign ? unwrap((statement.expression as ts.BinaryExpression).right) : undefined
      if (!value) continue
      if (ts.isIdentifier(value) && constants.has(value.text)) value = unwrap(constants.get(value.text)!)
      if (ts.isCallExpression(value)) {
        const fn = value.expression
        const binding = ts.isIdentifier(fn) ? bindings.get(fn.text) : undefined
        if (binding?.source === 'vite' && binding.imported === 'defineConfig' && value.arguments[0])
          value = unwrap(value.arguments[0])
      }
      if (config) { config = undefined; break }
      config = value
    }
    if (!config || !ts.isObjectLiteralExpression(config)) {
      result.entryUnknown = true; result.aliasesUnknown = true
      result.unresolved.push('Build configuration is not a static object: ' + name)
      continue
    }
    // 配置对象在导出前后被赋值/调用改写时，不能将初始字面量当作最终配置。
    const mutated = tree.statements.some(statement => ts.isExpressionStatement(statement)
      && !ts.isStringLiteralLike(statement.expression)
      && !(ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && statement.expression.left.getText(tree) === 'module.exports'))
    if (mutated) {
      result.entryUnknown = true; result.aliasesUnknown = true
      result.unresolved.push('Build configuration contains executable statements: ' + name)
    }
    const get = (input: ts.Node | undefined | 'unknown', key: string) => input === 'unknown'
      ? 'unknown' as const : property(input, key)
    const vite = options.flavorOf(name) === 'vite'
    const root = property(config, 'root')
    if (vite && root) {
      const value = root === 'unknown' ? undefined : string(root)
      if (value === undefined) result.entryUnknown = true
      else result.root = isAbsolute(value) ? value : resolve(appRoot, value)
    }
    const aliasHost = vite ? property(config, 'resolve')
      : get(property(config, 'configureWebpack'), 'resolve')
    const rawAlias = get(aliasHost, 'alias')
    const alias = rawAlias && rawAlias !== 'unknown' ? unwrap(rawAlias) : rawAlias
    if (alias === 'unknown') result.aliasesUnknown = true
    else if (alias) {
      if (ts.isObjectLiteralExpression(alias)) {
        for (const item of alias.properties) {
          if (!ts.isPropertyAssignment(item) || !item.name
            || !(ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name))) {
            result.aliasesUnknown = true; continue
          }
          const value = string(item.initializer)
          if (value === undefined) result.opaqueAliases.push({ find: item.name.text })
          else result.aliases.push({ find: item.name.text, replacement: value })
        }
      } else if (ts.isArrayLiteralExpression(alias)) {
        for (const item of alias.elements) {
          const find = property(item, 'find'), replacement = property(item, 'replacement')
          const key = find && find !== 'unknown' ? string(find) : undefined
          const value = replacement && replacement !== 'unknown' ? string(replacement) : undefined
          const regex = find && find !== 'unknown' ? unwrap(find) : undefined
          if (regex && ts.isRegularExpressionLiteral(regex)) {
            // 正则 find 的匹配范围可静态确定：/body/flags；替换目标交给项目构建器在运行时解析。
            const text = regex.text
            const end = text.lastIndexOf('/')
            result.opaqueAliases.push({ pattern: text.slice(1, end), flags: text.slice(end + 1) })
          } else if (key !== undefined && value === undefined) result.opaqueAliases.push({ find: key })
          else if (key === undefined || value === undefined) result.aliasesUnknown = true
          else result.aliases.push({ find: key, replacement: value })
        }
      } else result.aliasesUnknown = true
    }
    const addEntries = (node: ts.Node | undefined | 'unknown') => {
      if (!node) return
      if (node === 'unknown') { result.entryUnknown = true; return }
      node = unwrap(node)
      const value = string(node)
      if (value !== undefined) { result.entries.push(value); return }
      if (ts.isArrayLiteralExpression(node)) { for (const item of node.elements) addEntries(item); return }
      if (ts.isObjectLiteralExpression(node)) {
        for (const item of node.properties) {
          if (ts.isPropertyAssignment(item)) addEntries(item.initializer)
          else result.entryUnknown = true
        }
        return
      }
      result.entryUnknown = true
    }
    if (vite) addEntries(get(get(property(config, 'build'), 'rollupOptions'), 'input'))
    if (vite) {
      // R5-1e：plugins 数组中对 'vite-plugin-mock' 导入符号的调用，只解释字面量选项；
      // 无法完整求值时不执行项目 Mock（'unresolved'），不猜默认值。
      const mockCalls: ts.Expression[] = []
      const plugins = property(config, 'plugins')
      if (plugins && plugins !== 'unknown') {
        const node = unwrap(plugins)
        if (ts.isArrayLiteralExpression(node)) for (const item of node.elements) {
          const call = unwrap(item)
          if (!ts.isCallExpression(call)) continue
          const fn = unwrap(call.expression)
          const binding = ts.isIdentifier(fn) ? bindings.get(fn.text) : undefined
          if (binding?.source === 'vite-plugin-mock')
            mockCalls.push(call.arguments[0] ?? ts.factory.createObjectLiteralExpression())
        }
      }
      if (mockCalls.length > 1) result.mockPlugin = 'unresolved'
      else if (mockCalls.length === 1) {
        const optionKeys = new Set(['mockPath', 'localEnabled', 'enable', 'prodEnabled', 'watchFiles', 'logger',
          'cors'])
        const mockOptions = unwrap(mockCalls[0]!)
        if (!ts.isObjectLiteralExpression(mockOptions)) result.mockPlugin = 'unresolved'
        else {
          let mockPath = 'mock'
          let unresolved = false
          for (const item of mockOptions.properties) {
            if (!ts.isPropertyAssignment(item) || !item.name
              || !(ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name))
              || !optionKeys.has(item.name.text)) { unresolved = true; break }
            const key = item.name.text
            const value = unwrap(item.initializer)
            if (key === 'mockPath') {
              const text = string(value)
              if (text === undefined) { unresolved = true; break }
              mockPath = text
              continue
            }
            const bool = value.kind === ts.SyntaxKind.TrueKeyword ? true
              : value.kind === ts.SyntaxKind.FalseKeyword ? false : undefined
            if (bool === undefined) { unresolved = true; break }
            if ((key === 'localEnabled' || key === 'enable' || key === 'prodEnabled') && !bool) {
              unresolved = true; break
            }
          }
          result.mockPlugin = unresolved ? 'unresolved' : { mockPath }
        }
      }
    }
    else {
      addEntries(get(property(config, 'configureWebpack'), 'entry'))
      const pages = property(config, 'pages')
      if (pages === 'unknown') result.entryUnknown = true
      else if (pages && ts.isObjectLiteralExpression(pages)) for (const item of pages.properties) {
        if (!ts.isPropertyAssignment(item)) { result.entryUnknown = true; continue }
        const entry = property(item.initializer, 'entry')
        const shorthand = ts.isStringLiteralLike(item.initializer) || ts.isArrayLiteralExpression(item.initializer)
        if (entry === undefined && !shorthand) result.entryUnknown = true
        addEntries(shorthand ? item.initializer : entry)
      }
      else if (pages) result.entryUnknown = true
      if (property(config, 'chainWebpack') !== undefined || property(config, 'configureWebpack') === 'unknown') {
        result.entryUnknown = true; result.aliasesUnknown = true
      }
    }
  }
  if (result.aliasesUnknown) result.unresolved.push(
    'Build aliases contain dynamic or ambiguous configuration; do not assume bare names are third-party')
  if (result.entryUnknown) result.unresolved.push('Build entries require explicit runtime.entry or manual binding')
  result.entries = [...new Set(result.entries)]
  return result
}
