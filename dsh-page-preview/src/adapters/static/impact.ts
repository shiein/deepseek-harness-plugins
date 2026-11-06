/**
 * 静态站点的影响分析（方案 §5.2；R3 计划 R3-4）。只读 HTML/CSS 文本。
 *
 * - HTML 文件自身改动 → strong（selector: file 指向该 HTML）
 * - 被 HTML 的 <script src>、<link href>、<img src> 等直接引用的资源改动 → strong（单页）/ medium（多页共享）
 * - CSS 中 @import / url() 的字面量引用 → 追溯到引用它的 HTML（一跳）
 * - 运行时计算的引用（JS 拼接路径）→ gaps
 * - publicRoot 之外的改动不是可服务资源 → unrelated
 * 复用 static/preflight.ts 的扫描预算与 shared/html.ts 的解析，不新增依赖。
 */

import { opendir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import type { AdapterContext } from '../types.ts'
import type { FileChange } from '../../core/change/baseline.ts'
import type { AdapterImpact, ImpactEdge } from '../../core/impact/types.ts'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import { readProjectText } from '../../shared/profile.ts'
import { parseHtmlSource } from '../../shared/html.ts'

const SCAN_BUDGET = 5000
const HTML_EXT = /\.html?$/i
const CSS_EXT = /\.css$/i
// publicRoot 本身就是可服务目录：dist/build/lib 等名字在静态站点里可能就是真实页面目录，
// 只有永远不可能承载页面的目录才跳过；其余交给扫描预算兜底（超限进 gaps）。
const SKIP_DIRS = new Set(['node_modules', 'coverage'])
const CSS_URL = /@import\s+['"]([^'"]+)['"]|url\(\s*['"]?([^'")]+)['"]?\s*\)/g

const toRel = (from: string, to: string) => relative(from, to).split(sep).join('/')

/** HTML 引用值 → publicRoot 相对路径；外部/无法静态确定的引用返回 undefined。 */
function referencePath(root: string, htmlRel: string, value: string): string | undefined {
  if (!value || value.startsWith('#') || /^(?:[a-z]+:)?\/\//i.test(value) || /^[a-z]+:/i.test(value)) return undefined
  const clean = value.split(/[?#]/)[0]!
  const combined = clean.startsWith('/') ? join(root, clean.slice(1)) : join(root, dirname(htmlRel), clean)
  const rel = toRel(root, normalize(combined))
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : rel
}

export async function impactStatic(ctx: AdapterContext, changes: readonly FileChange[]): Promise<AdapterImpact> {
  const edges: ImpactEdge[] = []
  const gaps: string[] = []
  const unrelated: string[] = []
  let root: string
  try {
    root = await resolveProjectPath(ctx.appRoot, ctx.config.project.runtime.publicRoot ?? '.',
      ctx.config.project.runtime.dependencyRoots)
    if (!(await stat(root)).isDirectory()) throw new Error('Static publicRoot must be a directory')
  } catch {
    gaps.push('Static publicRoot could not be resolved; document impact analysis was skipped')
    return { edges, gaps, unrelated, manualOnly: true }
  }
  // 有界扫描 publicRoot 下的 HTML；file → 引用它的 HTML 集合。
  const fileHtmls = new Map<string, Set<string>>()
  const link = (file: string, html: string) => {
    const set = fileHtmls.get(file) ?? new Set<string>()
    set.add(html)
    fileHtmls.set(file, set)
  }
  const directories = [root]
  let entries = 0
  while (directories.length) {
    const directory = directories.shift()!
    const names: string[] = []
    try {
      for await (const entry of await opendir(directory)) {
        if (++entries > SCAN_BUDGET) { gaps.push('Static impact scan reached its 5000-entry budget'); break }
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        const file = join(directory, entry.name)
        if (entry.isDirectory()) directories.push(file)
        else if (entry.isFile()) names.push(file)
      }
    } catch (error) {
      gaps.push('Unable to scan ' + toRel(root, directory) + ': '
        + (error instanceof Error ? error.message : String(error)))
      continue
    }
    for (const file of names) {
      if (!HTML_EXT.test(file)) continue
      const htmlRel = toRel(root, file)
      const source = await readProjectText(file, root)
      if (source === undefined) continue
      link(htmlRel, htmlRel) // 文档自身也是可打开目标
      for (const reference of parseHtmlSource(source).references) {
        const target = referencePath(root, htmlRel, reference.value)
        if (target === undefined) continue
        link(target, htmlRel)
      }
    }
  }
  // CSS 一跳：样式文件自身的 @import/url() 字面量继承引用它的 HTML 集合。
  for (const [css, htmls] of [...fileHtmls.entries()]) {
    if (!CSS_EXT.test(css)) continue
    const source = await readProjectText(join(root, css), root)
    if (source === undefined) continue
    for (const match of source.matchAll(CSS_URL)) {
      const value = match[1] ?? match[2]
      if (value === undefined) continue
      const target = referencePath(root, css, value)
      if (target === undefined) continue
      for (const html of htmls) link(target, html)
    }
  }
  for (const change of changes) {
    const file = join(ctx.appRoot, change.path.split('/').join(sep))
    const rel = toRel(root, file)
    if (rel.startsWith('..') || isAbsolute(rel)) { unrelated.push(change.path); continue }
    if (HTML_EXT.test(rel) && change.kind !== 'deleted') {
      edges.push({ changed: change.path, selector: { kind: 'file', path: change.path },
        relation: [change.path], evidence: 'strong', scope: 'page' })
      continue
    }
    const htmls = [...fileHtmls.get(rel) ?? []].filter(html => html !== rel).sort()
    if (!htmls.length) { unrelated.push(change.path); continue }
    for (const html of htmls) {
      edges.push({ changed: change.path, selector: { kind: 'file', path: toRel(ctx.appRoot, join(root, html)) },
        relation: [change.path, html], evidence: htmls.length === 1 ? 'strong' : 'medium', scope: 'page' })
    }
  }
  return { edges, gaps, unrelated, manualOnly: false }
}
