/** JS/TS/JSX 只读 AST 摘要（方案 §5.2、§6.9、§11）；不加载项目解析器或执行项目模块。 */
import ts from 'typescript'

export interface ScriptReference { value: string; kind: 'module' | 'worker' | 'asset' | 'script' }
export interface ScriptSource {
  references: ScriptReference[]
  exports: string[]
  jsx: boolean
  typescript: boolean
  invalid: boolean
  unresolved: string[]
}

/** requireLiterals：额外把 require('字面量') 收为 module 引用；默认关，避免误报 UMD 探测性 require。 */
export function parseScriptSource(file: string, source: string,
  options?: { requireLiterals?: boolean }): ScriptSource {
  const kind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/i.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const syntax = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true } })
  const result: ScriptSource = { references: [], exports: [], jsx: false, typescript: false, invalid: syntax.diagnostics?.some(value => value.category === ts.DiagnosticCategory.Error) ?? false, unresolved: [] }
  const reference = (node: ts.Node | undefined, type: ScriptReference['kind']) => {
    if (node && ts.isStringLiteralLike(node)) result.references.push({ value: node.text, kind: type })
    else result.unresolved.push('Computed ' + type + ' reference')
  }
  // 逐节点检查；遍历用显式栈而非递归：压缩产物的深层二元表达式会让递归 forEachChild 栈溢出（2026-11-03 实机）。
  const inspect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) reference(node.moduleSpecifier, 'module')
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && node.isTypeOnly) result.typescript = true
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) reference(node.arguments[0], 'module')
    if (options?.requireLiterals && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'require') reference(node.arguments[0], 'module')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'importScripts') for (const argument of node.arguments) reference(argument, 'script')
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'register' && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === 'serviceWorker') reference(node.arguments[0], 'script')
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['Worker', 'SharedWorker'].includes(node.expression.text)) {
      const argument = node.arguments?.[0]
      if (argument && ts.isNewExpression(argument) && ts.isIdentifier(argument.expression) && argument.expression.text === 'URL') reference(argument.arguments?.[0], 'worker')
      else reference(argument, 'worker')
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1] && ts.isPropertyAccessExpression(node.arguments[1]) && node.arguments[1].name.text === 'url') reference(node.arguments[0], 'asset')
    if (ts.isExportAssignment(node) && !node.isExportEquals) result.exports.push('default')
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) for (const value of node.exportClause.elements) result.exports.push(value.name.text)
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(value => value.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.getModifiers(node)?.some(value => value.kind === ts.SyntaxKind.DefaultKeyword)) result.exports.push('default')
      else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) result.exports.push(declaration.name.text)
      }
      else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) result.exports.push(node.name.text)
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) result.jsx = true
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isTypeNode(node) && node.kind !== ts.SyntaxKind.ExpressionWithTypeArguments) result.typescript = true
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(value => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.DeclareKeyword, ts.SyntaxKind.AbstractKeyword, ts.SyntaxKind.OverrideKeyword].includes(value.kind))) result.typescript = true
  }
  const stack: ts.Node[] = [tree]
  while (stack.length) {
    const node = stack.pop()!
    inspect(node)
    const children: ts.Node[] = []
    ts.forEachChild(node, child => { children.push(child) })
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!)
  }
  result.exports = [...new Set(result.exports)]
  return result
}
