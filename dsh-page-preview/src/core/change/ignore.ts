/**
 * 基线扫描的忽略规则（方案 §5.3；R3 计划 R3-4）。
 *
 * - 固定排除 DEFAULT_IGNORES（依赖、缓存、VCS 目录），作为最低优先级的内建规则
 * - 读取工作区根的 .gitignore（只读）；各级目录的 .gitignore 由扫描方在进入目录时经 addRules 增量提供，
 *   规则只作用于其所在子树，后命中覆盖先命中（与 gitignore 语义一致）
 * - 首版支持的子集：注释、空行、`!` 取反、`/` 锚定、结尾 `/` 仅目录、`*`、`**`、`?`；
 *   其余语法（如 [] 字符类、转义符）记入 unsupported 并按"不忽略"处理（宁可多扫，不漏变化）
 * - 静态产物目录（dist 等）若被某目标显式声明为 publicRoot，则经 forceInclude 不被忽略
 *   （§5.3：不能全局排除 dist 后又承诺支持已有产物）
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_IGNORES } from './baseline.ts'

export interface IgnoreMatcher {
  /** relPath 使用 '/' 分隔，相对工作区。 */
  ignores(relPath: string, isDirectory: boolean): boolean
  /** 读取到但未支持的规则（文件:行），用于诊断，不含规则以外的文件内容。 */
  unsupported: string[]
  /** 扫描方在进入目录发现 .gitignore 时按子树追加规则；base 为该目录的工作区相对路径（'' 为根）。 */
  addRules(base: string, label: string, source: string): void
}

export interface IgnoreOptions {
  /** 被目标显式声明、必须纳入扫描的目录（相对工作区，'/' 分隔）。 */
  forceInclude?: readonly string[]
}

interface Rule {
  /** 规则所属 .gitignore 的目录（工作区相对 '/'，'' 为根；非空时带结尾 '/'）。 */
  base: string
  /** 相对 base 的匹配式：anchored 匹配整条相对路径，否则只匹配路径末级名。 */
  regex: RegExp
  anchored: boolean
  dirOnly: boolean
  negated: boolean
}

const GLOB_CHAR = /[.^$+(){}|\\[\]]/g

/** 把单个 gitignore glob 段翻译成正则片段；不支持的语法返回 undefined。 */
function globPattern(pattern: string): RegExp | undefined {
  if (/[\[\]\\]/.test(pattern)) return undefined
  let source = ''
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith('**/', index)) { source += '(?:[^/]+/)*'; index += 3; continue }
    if (pattern.startsWith('**', index) && index === pattern.length - 2) {
      source += '[^/]+(?:/[^/]+)*'; index += 2; continue
    }
    const char = pattern[index]!
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '/') source += '/'
    else source += char.replace(GLOB_CHAR, '\\$&')
    index += 1
  }
  return new RegExp('^' + source + '$')
}

function compileLine(raw: string, base: string, label: string, line: number, unsupported: string[]): Rule | undefined {
  const location = label + ':' + line
  let text = raw.trim()
  if (!text || text.startsWith('#')) return undefined
  if (/[\\][\s#]/.test(text)) { unsupported.push(location); return undefined }
  const negated = text.startsWith('!')
  if (negated) text = text.slice(1)
  if (!text) return undefined
  const dirOnly = text.endsWith('/')
  if (dirOnly) text = text.slice(0, -1)
  if (!text) { unsupported.push(location); return undefined }
  const anchored = text.includes('/')
  const body = anchored ? text.replace(/^\//, '') : text
  const regex = globPattern(body)
  if (regex === undefined) { unsupported.push(location); return undefined }
  return { base, regex, anchored, dirOnly, negated }
}

export async function loadIgnoreMatcher(workspaceRoot: string, options: IgnoreOptions = {}): Promise<IgnoreMatcher> {
  const unsupported: string[] = []
  const rules: Rule[] = DEFAULT_IGNORES.map(name => ({
    base: '', regex: new RegExp('^' + name.replace(GLOB_CHAR, '\\$&') + '$'),
    anchored: false, dirOnly: true, negated: false,
  }))
  const addRules = (base: string, label: string, source: string) => {
    const prefix = base ? base.replace(/\/?$/, '/') : ''
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const rule = compileLine(line, prefix, label, index + 1, unsupported)
      if (rule) rules.push(rule)
    }
  }
  try { addRules('', '.gitignore', await readFile(join(workspaceRoot, '.gitignore'), 'utf8')) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const forced = (options.forceInclude ?? []).map(path => path.replace(/\/?$/, ''))
  const ignores = (relPath: string, isDirectory: boolean): boolean => {
    const clean = relPath.replace(/\/+$/, '')
    // 强制包含：命中目录本身/其后代直接放行；其祖先也不得被忽略（否则根本扫不到该目录）。
    if (forced.some(dir => clean === dir || clean.startsWith(dir + '/') || dir.startsWith(clean + '/')))
      return false
    // 任一祖先目录命中忽略规则即整个子树被忽略（gitignore 目录语义）。
    const parts = clean.split('/')
    const candidates: Array<{ path: string, dir: boolean }> = []
    for (let index = 1; index <= parts.length; index++)
      candidates.push({ path: parts.slice(0, index).join('/'), dir: index < parts.length || isDirectory })
    let ignored = false
    for (const rule of rules) {
      for (const candidate of candidates) {
        // 子树规则只作用于其 base 之下；base 目录自身及其祖先不受其 .gitignore 约束。
        if (rule.base && !candidate.path.startsWith(rule.base)) continue
        const sub = candidate.path.slice(rule.base.length)
        if (rule.dirOnly && !candidate.dir) continue
        const matched = rule.anchored ? rule.regex.test(sub)
          : rule.regex.test(candidate.path.split('/').pop()!)
        if (matched) ignored = !rule.negated
      }
    }
    return ignored
  }
  return { ignores, unsupported, addRules }
}
