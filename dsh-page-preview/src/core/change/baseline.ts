/**
 * 轮次变更基线（方案 §5.3；R3 计划 R3-4）。
 * - 基线 = (path, size, mtimeMs, ino) 元数据索引，遵守忽略规则（ignore.ts）；不做全仓内容哈希
 * - 结束时只对元数据变化文件与工具事件上报的路径算内容哈希；内容未变视为未变化
 * - 删除 + 新增且内容哈希相同 → 重命名
 * - Git 仓库可用 `git status --porcelain=v2 -z` 加速，但不替代上述规则，也不把已有未提交改动算作本轮（首版可不做）
 * - 索引耗时超过阈值时降级为只追踪已登记目标及其已知依赖目录，并给出诊断（degraded）
 *
 * 内容哈希的前提：基线需要能拿到"变化前的内容哈希"才能判定"内容未变"与"重命名"。
 * 设计选择（R3-4 实现时定稿并写入 docs/r3-plan.md）：基线只存元数据，变化前的哈希按需在
 * createBaseline 时对"已登记目标及其直接依赖"预先计算；其余文件元数据变化即视为 modified（如实，不声称内容已变）。
 */

import { createHash } from 'node:crypto'
import { opendir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { ChangeOrigin } from '../../shared/contracts.ts'
import { loadIgnoreMatcher } from './ignore.ts'
import type { IgnoreMatcher } from './ignore.ts'

export interface FileMeta {
  size: number
  mtimeMs: number
  ino?: number
  /** 预先计算的内容哈希（仅已登记目标及其直接依赖，见文件头）。 */
  hash?: string
}

export interface Baseline {
  workspaceRoot: string
  createdAt: number
  /** key 为相对工作区的 '/' 分隔路径。 */
  entries: Map<string, FileMeta>
  /** 降级时说明原因（预算耗尽、扫描出错等）。 */
  degraded?: string
  /** 复用同一匹配器的后续扫描保持同一套忽略规则（内部字段，不参与序列化）。 */
  matcher: IgnoreMatcher
  /** 读取到但未支持的 .gitignore 规则（文件:行）。 */
  ignoreNotes: string[]
}

export interface FileChange {
  kind: 'added' | 'modified' | 'deleted' | 'renamed'
  /** 相对工作区的 '/' 分隔路径；renamed 时为新路径。 */
  path: string
  from?: string
  origin: ChangeOrigin
}

/** 默认排除目录。静态产物目录只有被目标声明时才纳入（ignore.ts 的 forceInclude）。 */
export const DEFAULT_IGNORES = ['node_modules', '.git', '.cache', '.vite', '.turbo', '.next', '.nuxt', 'coverage']

/** 默认索引时间预算（ms）；R5-9 实测：30k 文件全扫约 300ms，1500ms 覆盖约 15 万文件量级。 */
export const DEFAULT_TIME_BUDGET_MS = 1500

export interface BaselineOptions {
  timeBudgetMs?: number
  /** 被目标声明、必须纳入的目录（相对工作区）。 */
  forceInclude?: readonly string[]
  /** 需要预先计算内容哈希的文件（相对工作区），见文件头。 */
  hashPaths?: readonly string[]
}

interface ScanResult {
  entries: Map<string, FileMeta>
  notes: string[]
  truncated: boolean
}

/** 有界目录遍历：点号项不索引（与 scanProjectFiles 一致），.gitignore 例外以加载嵌套规则。 */
async function scanWorkspace(root: string, matcher: IgnoreMatcher, deadline: number): Promise<ScanResult> {
  const entries = new Map<string, FileMeta>()
  const notes: string[] = []
  const note = (text: string) => { if (notes.length < 8) notes.push(text) }
  const directories = ['']
  let truncated = false
  while (directories.length && !truncated) {
    if (Date.now() > deadline) { truncated = true; break }
    const directory = directories.shift()!
    const dirents: Array<{ name: string, dir: boolean, file: boolean }> = []
    try {
      for await (const entry of await opendir(join(root, directory)))
        dirents.push({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() })
    } catch (error) {
      note('Unable to scan ' + (directory || '.') + ': ' + (error instanceof Error ? error.message : String(error)))
      continue
    }
    const gitignore = dirents.find(entry => entry.file && entry.name === '.gitignore')
    if (gitignore) {
      const label = directory ? directory + '/.gitignore' : '.gitignore'
      try { matcher.addRules(directory, label, await readFile(join(root, label), 'utf8')) }
      catch (error) {
        note('Unable to read ' + label + ': ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    for (const entry of dirents) {
      if (entry.name.startsWith('.')) continue
      const rel = directory ? directory + '/' + entry.name : entry.name
      if (matcher.ignores(rel, entry.dir)) continue
      if (entry.dir) directories.push(rel)
      else if (entry.file) {
        try {
          const info = await stat(join(root, rel))
          entries.set(rel, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino })
        } catch (error) {
          note('Unable to stat ' + rel + ': ' + (error instanceof Error ? error.message : String(error)))
        }
      }
    }
  }
  return { entries, notes, truncated }
}

async function hashFile(root: string, rel: string): Promise<string | undefined> {
  // 内容哈希只针对已登记目标及其依赖；.env* 即使有声明也不读取（§5 第 10 条）。
  if (/^\.env(?:\.|$)/.test(basename(rel))) return undefined
  try { return createHash('sha256').update(await readFile(join(root, rel))).digest('hex') }
  catch { return undefined }
}

export async function createBaseline(workspaceRoot: string, opts: BaselineOptions = {}): Promise<Baseline> {
  const root = await realpath(workspaceRoot)
  const matcher = await loadIgnoreMatcher(root,
    opts.forceInclude === undefined ? {} : { forceInclude: opts.forceInclude })
  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
  const scan = await scanWorkspace(root, matcher, deadline)
  const degraded = [
    ...(scan.truncated ? ['Baseline scan exceeded its ' + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)
      + 'ms budget; coverage is incomplete'] : []),
    ...scan.notes,
  ]
  for (const rel of opts.hashPaths ?? []) {
    const entry = scan.entries.get(rel)
    if (!entry) continue
    const hash = await hashFile(root, rel)
    if (hash !== undefined) entry.hash = hash
  }
  return {
    workspaceRoot: root, createdAt: Date.now(), entries: scan.entries, matcher,
    ignoreNotes: [...matcher.unsupported],
    ...(degraded.length ? { degraded: degraded.join('; ') } : {}),
  }
}

export interface DiffOutcome {
  changes: FileChange[]
  /** 重扫截断/读取失败等降级说明；空数组表示完整。 */
  degraded: string[]
}

/**
 * agentConfirmed（工作区内绝对路径）中的路径标为 agent-confirmed，其余为 workspace-observed。
 * 基线建立前已存在的未提交改动不算入本轮（只比较基线与当前）。
 */
export async function diffBaseline(baseline: Baseline, agentConfirmed: ReadonlySet<string>): Promise<DiffOutcome> {
  const deadline = Date.now() + DEFAULT_TIME_BUDGET_MS
  const scan = await scanWorkspace(baseline.workspaceRoot, baseline.matcher, deadline)
  const degraded = [
    ...(scan.truncated ? ['Diff rescan exceeded its ' + DEFAULT_TIME_BUDGET_MS
      + 'ms budget; some workspace changes may be missing'] : []),
    ...scan.notes,
  ]
  const deleted = new Map<string, FileMeta>()
  const added = new Map<string, FileMeta>()
  const modified = new Map<string, FileMeta>()
  for (const [rel, before] of baseline.entries) if (!scan.entries.has(rel)) deleted.set(rel, before)
  for (const [rel, now] of scan.entries) {
    const before = baseline.entries.get(rel)
    if (!before) { added.set(rel, now); continue }
    if (before.size === now.size && before.mtimeMs === now.mtimeMs && before.ino === now.ino) continue
    // 有基线哈希可证内容未变；无哈希时元数据变化即如实记为 modified（不声称内容已变）。
    if (before.hash !== undefined && before.hash === await hashFile(baseline.workspaceRoot, rel)) continue
    modified.set(rel, now)
  }
  // 删除 + 新增且内容哈希相同 → 重命名；只对存在带哈希删除项时计算新增文件哈希。
  const renamed = new Map<string, string>()
  if ([...deleted.values()].some(meta => meta.hash !== undefined)) {
    for (const rel of added.keys()) {
      const hash = await hashFile(baseline.workspaceRoot, rel)
      if (hash === undefined) continue
      const source = [...deleted.entries()].find(([, meta]) => meta.hash === hash)?.[0]
      if (source !== undefined) {
        renamed.set(rel, source)
        added.delete(rel)
        deleted.delete(source)
      }
    }
  }
  const origin = (rel: string): ChangeOrigin =>
    agentConfirmed.has(join(baseline.workspaceRoot, rel.split('/').join(sep)))
      ? 'agent-confirmed' : 'workspace-observed'
  const changes: FileChange[] = [
    ...[...added.keys()].map(path => ({ kind: 'added' as const, path, origin: origin(path) })),
    ...[...modified.keys()].map(path => ({ kind: 'modified' as const, path, origin: origin(path) })),
    ...[...deleted.keys()].map(path => ({ kind: 'deleted' as const, path, origin: origin(path) })),
    ...[...renamed.entries()].map(([path, from]) => ({ kind: 'renamed' as const, path, from, origin: origin(path) })),
  ]
  changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { changes, degraded }
}
