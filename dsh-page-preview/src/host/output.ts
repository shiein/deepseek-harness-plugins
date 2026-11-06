/**
 * 面向模型的输出渲染（方案 §4.2 输出预算）。
 * render 产出紧凑文本摘要（状态行 + 预览/候选/占用者 + 诊断），不再整段回显 JSON；
 * 结构化字段仍由 schema 值承载，完整计划经 status(detail=true) 获取。
 */

import type { DisplayedPreviewPlan, PreviewPlan, ToolResultBase } from '../shared/contracts.ts'

/** 默认最多返回的诊断条数（方案建议 5～10；R5-9 在 tests/toolchains 样本实测取 8）。 */
export const MAX_DIAGNOSTICS = 8

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

/** 契约对象都是纯 JSON 数据；此处做一次规范化，去掉 undefined 字段。 */
export function toJson(value: ToolResultBase): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function truncateDiagnostics<T extends ToolResultBase>(result: T): T {
  if (result.diagnostics.length <= MAX_DIAGNOSTICS) return result
  return {
    ...result,
    diagnostics: result.diagnostics.slice(0, MAX_DIAGNOSTICS),
    diagnosticsTruncated: (result.diagnosticsTruncated ?? 0) + result.diagnostics.length - MAX_DIAGNOSTICS,
  }
}

/** 模型可见计划不携带命令参数/执行环境值；不以空参数伪装真实命令，内部计划和指纹保持不变。 */
export function visiblePlan(plan: PreviewPlan): DisplayedPreviewPlan {
  const copy = structuredClone(plan)
  if (copy.process.kind === 'managed') {
    const { kind, executable, cwd } = copy.process
    return { ...copy, process: { kind, executable, cwd, executionDetailsOmitted: ['args', 'env'] }, knownDifferences: [...copy.knownDifferences, 'Execution arguments and environment values are omitted from tool output; inspect the trusted user approval UI'] }
  }
  return { ...copy, process: copy.process }
}

/** 工具结果的模型可见渲染：逐字段投影为短行；未识别的结构退回原值序列化，不补造字段。 */
export function renderResult(value: JsonValue) {
  return [{ type: 'text' as const, text: summarizeResult(value) }]
}

function summarizeResult(value: JsonValue): string {
  const result = objectOf(value)
  if (!result) return JSON.stringify(value)
  const lines: string[] = [`status: ${stringOf(result.status) ?? 'unknown'}`]
  if (result.preview !== undefined) lines.push(...previewLines(result.preview))
  for (const preview of arrayOf(result.previews)) lines.push(...previewLines(preview))
  const occupant = objectOf(result.occupant)
  if (occupant) lines.push(`occupant: preview=${stringOf(occupant.previewId) ?? '?'} state=${stringOf(occupant.state) ?? '?'} project=${stringOf(occupant.projectId) ?? '?'} target=${stringOf(occupant.targetId) ?? '?'} owner=${occupant.sameOwner === true ? 'this session' : 'another session'}`)
  const candidates = arrayOf(result.candidates)
  if (candidates.length) {
    lines.push('candidates:')
    for (const candidate of candidates) {
      const item = objectOf(candidate)
      if (!item) continue
      const relation = arrayOf(item.relation).map(stringOf).filter((entry): entry is string => entry !== undefined).join(' -> ')
      lines.push(`  - ${fields(item, ['projectId'])} selector=${JSON.stringify(item.selector ?? null)} evidence=${stringOf(item.evidence) ?? '?'}${relation ? ' via ' + relation : ''}`)
    }
  }
  const draft = objectOf(result.setupDraft)
  if (draft) {
    const groups = ['thirdParty', 'business', 'unresolved'].map(key => `${key}=${arrayOf(draft[key]).length}`)
    const installed = stringOf(draft.installedTo) === undefined ? '' : ` installedTo=${stringOf(draft.installedTo)}`
    const snippet = stringOf(draft.configSnippet) === undefined ? '' : ` config=${JSON.stringify(draft.configSnippet)}`
    lines.push(`setupDraft: path=${stringOf(draft.path) ?? '(not written)'}${installed} ${groups.join(' ')}${snippet}`)
    for (const key of ['thirdParty', 'business', 'unresolved']) {
      for (const entry of arrayOf(draft[key])) {
        const item = objectOf(entry)
        if (item) lines.push(`  - ${key}: ${fields(item, ['kind', 'source', 'reason'])}`)
      }
    }
  }
  const stopped = arrayOf(result.stopped)
  if (stopped.length) {
    lines.push('stopped:')
    for (const entry of stopped) {
      const item = objectOf(entry)
      if (!item) continue
      const residual = arrayOf(item.residual).map(stringOf).filter((value): value is string => value !== undefined)
      lines.push(`  - ${stringOf(item.previewId) ?? '?'}: ${stringOf(item.state) ?? '?'}${residual.length ? ' residual: ' + residual.join(', ') : ''}`)
    }
  }
  const recovered = objectOf(result.recovered)
  if (recovered) {
    lines.push(`recovered: reclaimed=${arrayOf(recovered.reclaimed).length} archived=${arrayOf(recovered.archived).length} residual=${arrayOf(recovered.residual).length}`)
    for (const key of ['residual', 'archived']) {
      for (const entry of arrayOf(recovered[key]).map(stringOf).filter((value): value is string => value !== undefined).slice(0, 10)) lines.push(`  ${key}: ${entry}`)
    }
  }
  if (result.plan !== undefined) lines.push('plan: ' + JSON.stringify(result.plan))
  const pageText = objectOf(result.pageText)
  if (pageText) lines.push(`pageText(${stringOf(pageText.url) ?? '?'}${pageText.truncated === true ? ', truncated' : ''}): ${stringOf(pageText.text) ?? ''}`)
  const capture = objectOf(result.capture)
  if (capture) lines.push('capture: ' + fields(capture, ['file', 'previewId', 'targetId', 'state', 'freshness', 'context', 'capturedAt']))
  const diagnostics = arrayOf(result.diagnostics)
  if (diagnostics.length) {
    lines.push('diagnostics:')
    for (const diagnostic of diagnostics) lines.push(diagnosticLine(diagnostic))
  }
  if (typeof result.diagnosticsTruncated === 'number' && result.diagnosticsTruncated > 0) lines.push(`  +${result.diagnosticsTruncated} more diagnostics; call page_preview_status with detail: true`)
  return lines.join('\n')
}

/** PreviewSummary 投影：首行身份与状态，次行来源，随后就绪证据与能力缺口。 */
function previewLines(value: JsonValue): string[] {
  const preview = objectOf(value)
  if (!preview) return []
  const url = stringOf(preview.url)
  const lines = [`preview ${stringOf(preview.previewId) ?? '?'}: state=${stringOf(preview.state) ?? '?'} freshness=${stringOf(preview.freshness) ?? '?'}${url ? ' url=' + url : ''}`]
  const meta = fields(preview, ['projectId', 'targetId', 'scope', 'strategy', 'scenario'])
  if (meta) lines.push('  ' + meta)
  const readiness = objectOf(preview.readiness)
  if (readiness) {
    const layer = (key: string) => stringOf(objectOf(readiness[key])?.status) ?? 'unverified'
    lines.push(`  readiness: service=${layer('serviceReachable')} document=${layer('documentLoaded')} target=${layer('targetMounted')}`)
  }
  const gaps = arrayOf(preview.capabilityGaps).map(gap => {
    const item = objectOf(gap)
    if (!item) return undefined
    const capability = objectOf(item.capability)
    const status = stringOf(capability?.status) ?? 'unknown'
    const reason = stringOf(capability?.reason)
    return `${stringOf(item.name) ?? '?'}=${status}${reason ? ` (${reason})` : ''}`
  }).filter((entry): entry is string => entry !== undefined)
  if (gaps.length) lines.push('  gaps: ' + gaps.join('; '))
  return lines
}

/** 诊断单行：[code/phase] previewId message (file:line|request) -> hint。 */
function diagnosticLine(value: JsonValue): string {
  const item = objectOf(value)
  if (!item) return '  - ' + JSON.stringify(value)
  const code = stringOf(item.code) ?? 'diagnostic'
  const phase = stringOf(item.phase)
  const previewId = stringOf(item.previewId)
  const location = objectOf(item.location)
  const at = location === undefined ? '' : [stringOf(location.file), typeof location.line === 'number' ? String(location.line) : undefined, stringOf(location.request)].filter((entry): entry is string => entry !== undefined).join(':')
  const hint = stringOf(item.hint)
  return `  - [${code}${phase ? '/' + phase : ''}]${previewId ? ' ' + previewId : ''} ${stringOf(item.message) ?? ''}${at ? ` (${at})` : ''}${hint ? ` -> ${hint}` : ''}`
}

function objectOf(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function arrayOf(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined
}

/** 把若干字段渲染为 key=value 序列；缺省字段跳过。 */
function fields(source: JsonObject, keys: string[]): string {
  return keys.map(key => {
    const value = stringOf(source[key])
    return value === undefined ? undefined : `${key}=${value}`
  }).filter((entry): entry is string => entry !== undefined).join(' ')
}
