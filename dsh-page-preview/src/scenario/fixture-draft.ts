/**
 * 未命中请求 → 场景 fixture 草稿（方案 §7.2；R3 计划 R3-1，Aesc 默认决策 D1）。纯函数，无 I/O。
 *
 * 目的：让 Agent 不必从诊断里逐条拼配置。草稿只给"请求匹配部分"的骨架，响应体用占位标记，
 * 由 Agent 依据项目接口类型/调用代码/API 文档填写真实形状的数据，并在 provenance 中注明来源。
 *
 * 硬约束（AGENTS.md §5 第 1、5 条）：
 *   - 不生成"看起来像真的"的业务数据；只有真实数据（项目 mock JSON、OpenAPI 显式
 *     example）才替换占位标记，schema 取样只进 shapeHints 提示，响应体保持 FIXTURE_PLACEHOLDER
 *   - validateConfig 必须拒绝仍含 FIXTURE_PLACEHOLDER 的 fixture（R3-1 在 shared/config/schema.ts 实现），
 *     防止未填写的草稿被粘贴后当作 mock 成功
 *   - 草稿不自动写入任何配置文件；写入由 Agent 自己编辑配置完成（项目配置或插件数据目录配置）
 *   - query 只放键名（值留空字符串需 Agent 决定是否约束），不放观察到的值
 *   - 跨源未命中（R5-1c）：fixture 按观察到的原 origin 生成（经同源 remote 通道匹配），
 *     同时列入 crossOrigin 报告；不参与 businessPaths 建议
 */

import type { HttpFixture } from '../shared/config/schema.ts'
import type { EnvelopeConfig } from '../shared/envelope.ts'
import {
  FIXTURE_PLACEHOLDER,
  type CallSiteContext,
  type EnvelopeHint,
  type FixtureDraft,
  type FixtureShapeHint,
  type HandlerDraft,
  type UnmatchedForDraft,
} from '../shared/fixture-draft.ts'
import type { DraftSourceEntry, FixtureSource } from './fixture-sources.ts'

export { FIXTURE_PLACEHOLDER, containsPlaceholder } from '../shared/fixture-draft.ts'
export type { FixtureDraft, FixtureShapeHint, HandlerDraft, UnmatchedForDraft } from '../shared/fixture-draft.ts'

/** 草稿中跨源条目的展示上限。 */
const MAX_CROSS_ORIGIN = 8

/**
 * 按 count 降序取前 maxFixtures 条同源条目生成草稿；method 大写；path 原样保留
 * （含纯数字/UUID 段）。跨源条目各自生成带 origin 的 fixture（R5-1c，上限 MAX_CROSS_ORIGIN）
 * 并列入 crossOrigin 报告，不计入 omitted（omitted 只表示同源排序截断）。
 * resolve（R5-1b）：真实数据来源（mock JSON / OpenAPI 显式 example）命中时响应体用真实值并写其
 * provenance；只有 schema 取样时记入 shapeHints 提示（值为示例）、响应体仍保持占位标记（R5-fix1）。
 */
// R6-1：options.envelope 为当前场景已声明的包装模板——草稿响应体只写 data 占位（占位标记语义即
// data 位置），configSnippet 原样带上 envelope 便于完整粘贴，不再把模板包进每条 fixture。
export interface DraftOptions {
  /** 当前场景已声明的响应包装；缺省表示未声明。 */
  envelope?: EnvelopeConfig
  /** R6-1d：识别出的包装线索建议（已声明 envelope 时调用方不提供）。 */
  envelopeHint?: EnvelopeHint
  /** R6-2：collectCallSiteContext 按条目收集的调用点上下文；typeHint 不进响应体。 */
  contexts?: CallSiteContext[]
  /** R6-2：收集触顶时置 true（同时由调用方产生可见诊断）。 */
  contextLimited?: boolean
}
export function draftFixtures(scenario: string, entries: readonly UnmatchedForDraft[], maxFixtures = 20,
  resolve?: (entry: DraftSourceEntry) => FixtureSource | undefined, options: DraftOptions = {}): FixtureDraft {
  const sameOrigin: UnmatchedForDraft[] = []
  const remote: UnmatchedForDraft[] = []
  for (const entry of entries) {
    if (entry.origin === undefined) sameOrigin.push(entry)
    else remote.push(entry)
  }
  const remoteSorted = [...remote].sort((a, b) => b.count - a.count || compareKey(a, b)).slice(0, MAX_CROSS_ORIGIN)
  const crossOrigin: FixtureDraft['crossOrigin'] = remoteSorted
    .map(entry => ({ method: entry.method, origin: entry.origin!, path: entry.path, count: entry.count }))
  const sorted = [...sameOrigin].sort((a, b) => b.count - a.count || compareKey(a, b))
  const kept = sorted.slice(0, Math.max(0, maxFixtures))
  const omitted = sorted.length - kept.length
  const shapeHints: FixtureShapeHint[] = []
  const draft = (entry: UnmatchedForDraft): HttpFixture => {
    const source = resolve?.({ method: entry.method.toUpperCase(), path: entry.path })
    if (source !== undefined && 'shapeHint' in source) {
      shapeHints.push({
        method: entry.method.toUpperCase(), path: entry.path,
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        shape: source.shapeHint.shape, provenance: source.shapeHint.provenance,
      })
    }
    const hit = source !== undefined && 'body' in source ? source : undefined
    return {
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      method: entry.method.toUpperCase(),
      path: entry.path,
      ...(entry.queryKeys.length ? { query: Object.fromEntries(entry.queryKeys.map(key => [key, ''])) } : {}),
      response: { status: 200, body: hit === undefined ? FIXTURE_PLACEHOLDER : hit.body },
      provenance: hit?.provenance
        ?? 'Drafted from an observed unmatched request; describe the real data source here',
    }
  }
  const fixtures: HttpFixture[] = [...kept.map(draft), ...remoteSorted.map(draft)]
  const businessPaths = suggestBusinessPaths(kept.map(entry => entry.path))
  const snippet: Record<string, unknown> = {
    ...(businessPaths.length ? { businessPaths } : {}),
    http: fixtures,
    // 场景已声明 envelope 时原样带上（Agent 粘贴片段即还原包装语义）；fixture body 保持 data 占位。
    ...(options.envelope === undefined ? {} : { envelope: options.envelope }),
  }
  return {
    scenario,
    fixtures,
    ...(shapeHints.length ? { shapeHints } : {}),
    ...(options.envelopeHint === undefined ? {} : { envelopeHint: options.envelopeHint }),
    ...(options.contexts === undefined ? {} : { contexts: options.contexts }),
    ...(options.contextLimited === undefined ? {} : { contextLimited: options.contextLimited }),
    businessPaths,
    configSnippet: JSON.stringify({ [scenario]: snippet }, null, 2),
    handlerDrafts: [...kept, ...remoteSorted].filter(isWrite).map(handlerDraft),
    omitted,
    crossOrigin,
  }
}

/** R5-1f：写方法未命中同时给出 handlers 模块条目模板——静态 fixture 不更新 Store，写读闭环只能靠 handler。 */
const isWrite = (entry: UnmatchedForDraft): boolean =>
  ['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method.toUpperCase())

function handlerDraft(entry: UnmatchedForDraft): HandlerDraft {
  const method = entry.method.toUpperCase()
  const guard = 'request.method !== ' + JSON.stringify(method)
    + (entry.origin === undefined ? '' : ' || request.origin !== ' + JSON.stringify(entry.origin))
    + ' || request.path !== ' + JSON.stringify(entry.path)
  const key = 'written:' + method + ' ' + (entry.origin ?? '') + entry.path
  const template = 'async (request, store) => {\n'
    + '  // ' + method + ' ' + (entry.origin ?? '') + entry.path + ' — a write is not reflected in later\n'
    + '  // reads unless this handler reads or writes the shared scenario store; declare the module\n'
    + '  // via scenario "handlers" (e.g. preview/handlers.js), which needs execution approval.\n'
    + '  if (' + guard + ') return undefined\n'
    + '  store.set(' + JSON.stringify(key) + ', request.body)\n'
    + '  return { status: 200, body: store.get(' + JSON.stringify(key) + ') }\n'
    + '}'
  return { method, path: entry.path,
    ...(entry.origin === undefined ? {} : { origin: entry.origin }), template }
}

/** 排序稳定键：count 相同时按 method+path 字典序，避免输出顺序依赖输入顺序。 */
function compareKey(a: UnmatchedForDraft, b: UnmatchedForDraft): number {
  return (a.method + ' ' + a.path).localeCompare(b.method + ' ' + b.path)
}

/**
 * 建议 businessPaths：取所有草稿 pathname 的最长公共目录前缀；至少共享一级目录才给出 '/**' 建议，
 * 否则退回首段目录去重（最多 4 条）。只是建议，Agent 需核对——过宽会让未命中变成歧义。
 */
function suggestBusinessPaths(paths: readonly string[]): string[] {
  const dirs = paths.map(path => path.split('/').slice(1, -1))
  if (!dirs.length) return []
  let prefix = dirs[0]!
  for (const dir of dirs.slice(1)) {
    let length = 0
    while (length < prefix.length && length < dir.length && prefix[length] === dir[length]) length += 1
    prefix = prefix.slice(0, length)
  }
  if (prefix.length) return ['/' + prefix.join('/') + '/**']
  const first = [...new Set(
    dirs.map(dir => dir[0]).filter((part): part is string => part !== undefined && part !== ''),
  )]
  return first.slice(0, 4).map(part => '/' + part + '/**')
}
