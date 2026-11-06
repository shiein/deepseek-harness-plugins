/**
 * page-preview.config.json 的场景写回（R5-1a、R5-F3、R5-F4；方案 §7.2、§8）。
 * 只改工作区根的仓库配置文件：plan 阶段只读并算好合并结果与备份路径，同时记录所依据的
 * 原文件内容 SHA-256；commit 阶段先重读比对（审批窗口内文件被改/被建即拒绝，什么都不写），
 * 再备份（已存在文件，EXCL 新名）后写——新文件用 wx 创建，已有文件不丢原内容（备份可回滚）。
 * 备份放插件 dataDir 的 config-backups/<工作区路径 SHA-256>/ 下，每个工作区只留最近 10 份，
 * 不往用户项目目录堆积。同名场景绝不覆盖；文件损坏/校验失败/合并后非法一律拒绝，不写半成品。
 */
import { copyFile, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { COPYFILE_EXCL } from 'node:constants'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { REPO_CONFIG_FILE } from '../shared/config/loader.ts'
import { validateConfig } from '../shared/config/schema.ts'
import type { ConfigIssue, ScenarioConfig } from '../shared/config/schema.ts'

export class ConfigWriteError extends Error {
  /** true = 依据文件在 plan 之后发生变化；调用方应提示重新生成 plan。 */
  readonly stale: boolean
  constructor(message: string, options?: { cause?: unknown; stale?: boolean }) {
    super(message, options)
    this.stale = options?.stale === true
  }
}

export interface ScenarioWritePlan {
  /** 工作区相对路径（始终 page-preview.config.json）。 */
  file: string
  absolute: string
  /** 已存在文件的备份绝对路径；新文件没有备份。 */
  backup?: string
  /** created=新文件；merged=并入既有项目条目；appended=追加项目条目。 */
  mode: 'created' | 'merged' | 'appended'
  content: string
  /** plan 依据的原文件内容 SHA-256；不携带表示 plan 时文件不存在（commit 时也必须仍不存在）。 */
  baseHash?: string
}

/** 每个工作区保留的最近备份份数；桶目录按工作区 canonical 路径 SHA-256 隔离。 */
const BACKUP_RETENTION = 10
const backupRoot = (dataDir: string, workspace: string): string =>
  join(dataDir, 'config-backups', createHash('sha256').update(workspace).digest('hex'))

/**
 * 只读计算写回计划；不写磁盘。dataDir 是备份的唯一落点。任何拒绝都以 ConfigWriteError 给出可操作说明。
 * mode='create'（缺省）：同名场景已存在即拒绝，语义不变。
 * mode='merge'（R6-3a）：目标场景必须已存在；http 只追加 (method, origin, path, query) 键尚不存在的
 * fixture，其余场景级字段（envelope 等）只能新增不能改写——键冲突或字段值不同即整体拒绝并列出冲突键。
 */
export async function planScenarioWrite(
  workspaceRoot: string,
  project: { id: string; root: string },
  name: string,
  definition: ScenarioConfig,
  dataDir: string,
  mode: 'create' | 'merge' = 'create',
): Promise<ScenarioWritePlan> {
  const workspace = await realpath(workspaceRoot)
  const absolute = join(workspace, REPO_CONFIG_FILE)
  const existing = await readFile(absolute, 'utf8').then(
    content => content,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new ConfigWriteError('Unable to read ' + REPO_CONFIG_FILE + '; the scenario was not written')
    },
  )
  if (existing === undefined) {
    if (mode === 'merge') {
      throw new ConfigWriteError(REPO_CONFIG_FILE + ' does not exist; use mode create for a new scenario')
    }
    const merged = {
      schemaVersion: 1,
      projects: [{ id: project.id, root: project.root, runtime: {}, scenarios: { [name]: definition } }],
    }
    const check = validateConfig(merged)
    if (!check.config) throw new ConfigWriteError('The new configuration would be invalid: ' + issuesText(check.issues))
    return { file: REPO_CONFIG_FILE, absolute, mode: 'created', content: serialize(merged) }
  }
  let raw: unknown
  try { raw = JSON.parse(existing) } catch {
    throw new ConfigWriteError(REPO_CONFIG_FILE + ' is not valid JSON; fix the file or merge the scenario manually')
  }
  const base = validateConfig(raw)
  if (!base.config) {
    throw new ConfigWriteError(REPO_CONFIG_FILE + ' does not validate ('
      + issuesText(base.issues) + '); fix the file or merge the scenario manually')
  }
  const record = raw as { projects?: Array<Record<string, unknown>> }
  const projects = Array.isArray(record.projects) ? record.projects : []
  const index = projects.findIndex(value => value.id === project.id)
  if (mode === 'merge' && index < 0) {
    throw new ConfigWriteError('Project ' + JSON.stringify(project.id) + ' has no entry in '
      + REPO_CONFIG_FILE + '; mode create writes a new one')
  }
  if (index >= 0) {
    const scenarios = (projects[index]!.scenarios ?? {}) as Record<string, unknown>
    if (Object.hasOwn(scenarios, name)) {
      if (mode === 'create') {
        throw new ConfigWriteError('Scenario ' + JSON.stringify(name) + ' already exists in '
          + REPO_CONFIG_FILE + '; choose another name or merge it manually')
      }
      const merge = mergeScenario(scenarios[name]!, definition)
      if (merge.conflicts.length) {
        throw new ConfigWriteError('Merging into scenario ' + JSON.stringify(name) + ' conflicts on '
          + merge.conflicts.slice(0, 6).join(', ')
          + (merge.conflicts.length > 6 ? ' (+' + String(merge.conflicts.length - 6) + ' more)' : '')
          + '; nothing was written')
      }
      projects[index]!.scenarios = { ...scenarios, [name]: merge.scenario }
    } else if (mode === 'merge') {
      throw new ConfigWriteError('Scenario ' + JSON.stringify(name) + ' does not exist in '
        + REPO_CONFIG_FILE + '; use mode create for a new scenario')
    } else {
      projects[index]!.scenarios = { ...scenarios, [name]: definition }
    }
  } else {
    projects.push({ id: project.id, root: project.root, runtime: {}, scenarios: { [name]: definition } })
  }
  const merged = validateConfig(record)
  if (!merged.config) {
    throw new ConfigWriteError('The merged configuration would be invalid (' + issuesText(merged.issues)
      + '); the scenario was not written')
  }
  return {
    file: REPO_CONFIG_FILE, absolute,
    backup: join(backupRoot(dataDir, workspace), REPO_CONFIG_FILE + '.bak-' + Date.now()),
    mode: index >= 0 ? 'merged' : 'appended', content: serialize(record),
    baseHash: createHash('sha256').update(existing).digest('hex'),
  }
}

/** 依据文件复核（TOCTOU）→ 备份（仅已有文件）→ 写入；任何一步不一致即拒绝，什么都不写。 */
export async function commitScenarioWrite(plan: ScenarioWritePlan): Promise<void> {
  const current = await readFile(plan.absolute, 'utf8').then(
    content => content,
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw new ConfigWriteError('Unable to read ' + plan.file + ' before writing; the scenario was not written')
    },
  )
  const unchanged = plan.baseHash !== undefined && current !== undefined
    && createHash('sha256').update(current).digest('hex') === plan.baseHash
  if (plan.baseHash === undefined ? current !== undefined : !unchanged) {
    throw new ConfigWriteError(plan.file + ' changed concurrently after the write plan was made; '
      + 'nothing was written', { stale: true })
  }
  try {
    if (plan.backup !== undefined) {
      const root = dirname(plan.backup)
      await mkdir(root, { recursive: true })
      await copyFile(plan.absolute, plan.backup, COPYFILE_EXCL)
      const prefix = REPO_CONFIG_FILE + '.bak-'
      const expired = (await readdir(root)).filter(entry => entry.startsWith(prefix))
        .sort().reverse().slice(BACKUP_RETENTION)
      for (const entry of expired) await rm(join(root, entry), { force: true })
    }
  } catch (error) {
    throw new ConfigWriteError('The configuration backup could not be created; the scenario was not written',
      { cause: error })
  }
  try {
    if (plan.mode === 'created') await writeFile(plan.absolute, plan.content, { flag: 'wx' })
    else await writeFile(plan.absolute, plan.content)
  } catch (error) {
    const exists = error instanceof Error && 'code' in error && error.code === 'EEXIST'
    throw new ConfigWriteError('The scenario could not be written to ' + plan.file
      + (exists ? ': the file appeared concurrently and was not overwritten' : ''), { cause: error })
  }
}

/**
 * R6-3a：merge 语义的纯函数部分——只追加新键，不覆盖、不改写。
 * - `http`：按 (method, origin, path, query) 键去重追加；键已存在即冲突。
 * - 其余字段：只新增（既有无该字段），值相同（键序无关）视为幂等，值不同即冲突。
 * 任何冲突都整体拒绝，不写半成品。
 */
function mergeScenario(existing: unknown, incoming: ScenarioConfig): { scenario: unknown; conflicts: string[] } {
  const base = (typeof existing === 'object' && existing !== null && !Array.isArray(existing)
    ? existing : {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...base }
  const conflicts: string[] = []
  const label = (fixture: { method: string; path: string; origin?: string }) =>
    fixture.method.toUpperCase() + ' ' + (fixture.origin ?? '') + ' ' + fixture.path
  for (const [field, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (value === undefined) continue
    if (field === 'http') {
      const kept = Array.isArray(base.http) ? base.http as Array<Record<string, unknown>> : []
      const keys = new Set(kept.map(fixtureKey))
      const added: unknown[] = []
      for (const fixture of value as Array<Record<string, unknown>>) {
        const key = fixtureKey(fixture)
        if (keys.has(key)) conflicts.push(label(fixture as { method: string; path: string; origin?: string }))
        else { keys.add(key); added.push(fixture) }
      }
      merged.http = [...kept, ...added]
      continue
    }
    if (!(field in base) || base[field] === undefined) {
      merged[field] = value
    } else if (stable(base[field]) !== stable(value)) {
      conflicts.push('field ' + field)
    }
  }
  return { scenario: merged, conflicts }
}

/** fixture 去重键：method 大写 + origin（同源为空）+ path + 键序无关的 query。 */
const fixtureKey = (fixture: Record<string, unknown>): string =>
  String(fixture.method).toUpperCase() + ' ' + String(fixture.origin ?? '') + ' ' + String(fixture.path)
    + ' ' + stable(fixture.query ?? {})

/** 键序无关的稳定序列化：只用于 config JSON 值（对象/数组/原始值）的相等比较。 */
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))
    : item)

function serialize(value: unknown): string { return JSON.stringify(value, null, 2) + '\n' }
function issuesText(issues: readonly ConfigIssue[]): string {
  return issues.slice(0, 3).map(issue => issue.path + ': ' + issue.message).join('; ')
}
