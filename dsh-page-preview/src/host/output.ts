/**
 * 面向模型的输出渲染（方案 §4.2 输出预算）。
 * render 产出紧凑文本摘要（状态行 + 预览/候选/占用者 + 诊断），不再整段回显 JSON；
 * 结构化字段仍由 schema 值承载，完整计划经 status(detail=true) 获取。
 */

import type { DisplayedPreviewPlan, PreviewPlan, ToolResultBase } from '../shared/contracts.ts'
import { FIXTURE_PLACEHOLDER } from '../shared/fixture-draft.ts'

/** 默认最多返回的诊断条数（方案建议 5～10；R5-9 在 tests/toolchains 样本实测取 8）。 */
export const MAX_DIAGNOSTICS = 8
const MOCK_SNIPPET_LIMIT = 8_000
const MOCK_LIST_LIMIT = 12

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
  const timing = timingLine(result.timing)
  if (timing) lines.push('  open timing: ' + timing)
  const availableScenarios = arrayOf(result.availableScenarios).map(stringOf).filter(Boolean)
  if (availableScenarios.length) lines.push('available scenarios (up to 10): ' + availableScenarios.join(', '))
  if (stringOf(result.file) && stringOf(result.scenario)) {
    lines.push('scenario saved: ' + fields(result, ['file', 'projectId', 'scenario', 'mode', 'backup']))
  }
  const applied = objectOf(result.applied)
  if (applied) lines.push('scenario apply: ' + fields(applied, ['previewId', 'status']))
  const unmatched = objectOf(result.unmatched)
  if (unmatched) lines.push(...unmatchedLines(unmatched))
  const fixtureDraft = objectOf(result.fixtureDraft)
  if (fixtureDraft) lines.push(...fixtureDraftLines(fixtureDraft))
  const occupant = objectOf(result.occupant)
  if (occupant) lines.push(`occupant: preview=${stringOf(occupant.previewId) ?? '?'} state=${stringOf(occupant.state) ?? '?'} project=${stringOf(occupant.projectId) ?? '?'} target=${stringOf(occupant.targetId) ?? '?'} owner=${occupant.sameOwner === true ? 'this session' : 'another session'}`)
  lines.push(...renderCandidateList('candidates', arrayOf(result.candidates)))
  lines.push(...renderCandidateList('suggestions', arrayOf(result.suggestions)))
  if (typeof result.suggestionsOmitted === 'number' && result.suggestionsOmitted > 0) {
    lines.push(`  +${result.suggestionsOmitted} more suggestions omitted`)
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
  if (preview.scenario === undefined) lines.push('  scenario: none selected')
  if (stringOf(preview.verification)) lines.push('  verification: ' + stringOf(preview.verification))
  const timing = timingLine(preview.startupTiming)
  if (timing) lines.push('  since Runner startup: ' + timing)
  const readiness = objectOf(preview.readiness)
  if (readiness) {
    const layer = (key: string) => stringOf(objectOf(readiness[key])?.status) ?? 'unverified'
    lines.push(`  readiness: service=${layer('serviceReachable')} document=${layer('documentLoaded')} target=${layer('targetMounted')}`)
    const target = objectOf(readiness.targetMounted)
    const mountSignal = stringOf(target?.mountSignal)
    const detail = stringOf(target?.detail)
    if (mountSignal !== undefined) lines.push('  browser mount: ' + mountSignal)
    if (detail !== undefined) lines.push('  target evidence: ' + detail)
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

function timingLine(value: JsonValue | undefined): string {
  const timing = objectOf(value)
  if (!timing) return ''
  return Object.entries(timing).flatMap(([key, elapsed]) => typeof elapsed === 'number' ? [`${key}=${elapsed}`] : [])
    .join(' ')
}

function unmatchedLines(unmatched: JsonObject): string[] {
  const entries = arrayOf(unmatched.entries)
  const elapsed = unmatched.sinceLastNewEntryMs
  const stabilized = typeof elapsed === 'number' ? ` sinceLastNewEntryMs=${elapsed}` : ''
  const lines = [`unmatched: observed=${entries.length} dropped=${unmatched.dropped ?? 0}${stabilized}`]
  for (const entry of entries.slice(0, MOCK_LIST_LIMIT)) {
    const item = objectOf(entry)
    if (!item) continue
    const origin = stringOf(item.origin) ?? ''
    const keys = arrayOf(item.queryKeys).map(stringOf).filter(Boolean).join(', ')
    lines.push(`  - ${stringOf(item.method)} ${origin}${stringOf(item.path)} ×${item.count ?? 0}`
      + (keys ? ` query keys: ${keys}` : ''))
  }
  if (entries.length > MOCK_LIST_LIMIT) lines.push(`  +${entries.length - MOCK_LIST_LIMIT} more in structured output`)
  const hint = stringOf(unmatched.hint)
  if (hint) lines.push('  ' + hint)
  return lines
}

function fixtureDraftLines(draft: JsonObject): string[] {
  const lines = [`fixtureDraft: ${fields(draft, ['scenario'])} omitted=${draft.omitted ?? 0}`]
  const snippet = stringOf(draft.configSnippet)
  if (snippet && snippet.length <= MOCK_SNIPPET_LIMIT) lines.push('fixtureDraft.configSnippet:', snippet)
  else if (snippet) lines.push(...compactFixtureLines(draft))
  for (const value of arrayOf(draft.shapeHints).slice(0, MOCK_LIST_LIMIT)) {
    const hint = objectOf(value)
    if (!hint) continue
    const target = `${stringOf(hint.origin) ?? ''}${stringOf(hint.path) ?? ''}`
    const shape = hint.shape === undefined ? '?' : boundedJson(hint.shape, 400)
    lines.push(`  shapeHint ${stringOf(hint.method) ?? '?'} ${target}: ${shape} (${stringOf(hint.provenance) ?? ''})`)
  }
  for (const value of arrayOf(draft.contexts).slice(0, MOCK_LIST_LIMIT)) {
    const context = objectOf(value)
    if (!context) continue
    const sites = arrayOf(context.requestSites).slice(0, 2).map(locationLine)
    const consumers = arrayOf(context.consumers).slice(0, 2).map(locationLine)
    const sources = [...sites, ...consumers].filter(Boolean)
    if (sources.length) lines.push(`  ${stringOf(context.method)} ${stringOf(context.path)}: ${sources.join(', ')}`)
    const typeHint = objectOf(context.typeHint)
    if (typeHint) {
      const prov = stringOf(typeHint.provenance)
      const shape = typeHint.shape === undefined ? undefined : boundedJson(typeHint.shape, 400)
      const parts = [prov, shape === undefined ? undefined : 'shape=' + shape].filter(Boolean)
      if (parts.length) lines.push('    response type: ' + parts.join(' '))
    }
  }
  const handlerDrafts = arrayOf(draft.handlerDrafts).slice(0, MOCK_LIST_LIMIT)
  if (handlerDrafts.length) {
    lines.push('  handlerDrafts (available in structured fixtureDraft.handlerDrafts):')
    let templateBudget = 2000
    for (const value of handlerDrafts) {
      const item = objectOf(value)
      if (!item) continue
      const target = `${stringOf(item.origin) ?? ''}${stringOf(item.path) ?? ''}`
      lines.push(`    - ${stringOf(item.method) ?? '?'} ${target}`)
      const tpl = stringOf(item.template)
      if (tpl && tpl.length <= templateBudget) {
        lines.push(tpl.split('\n').map(line => '      ' + line).join('\n'))
        templateBudget -= tpl.length
      }
    }
  }
  const envelope = objectOf(draft.envelopeHint)
  if (envelope?.template !== undefined) {
    const template = JSON.stringify(envelope.template)
    if (template.length <= 1024) lines.push('  envelope suggestion: ' + template)
  }
  if (draft.contextLimited === true) lines.push('  call-site context is partial')
  return lines
}

function compactFixtureLines(draft: JsonObject): string[] {
  const lines = ['fixtureDraft.configSnippet exceeds the text budget. Fill placeholders and retain the scene envelope.']
  const scenario = stringOf(draft.scenario)
  if (!scenario) return lines
  const entries = arrayOf(draft.fixtures).map(objectOf).filter(item => item !== undefined)
  let envelope: JsonValue | undefined = objectOf(draft.envelope)?.template !== undefined ? draft.envelope : undefined
  if (envelope === undefined) {
    const rawSnippet = stringOf(draft.configSnippet)
    if (rawSnippet) {
      try {
        const parsed = objectOf(JSON.parse(rawSnippet) as JsonValue)
        const scene = parsed ? objectOf(parsed[scenario]) : undefined
        if (scene && objectOf(scene.envelope)?.template !== undefined) envelope = scene.envelope
      } catch { /* ignore malformed snippet */ }
    }
  }
  const http: JsonObject[] = []
  const snippet = () => JSON.stringify({
    [scenario]: {
      businessPaths: arrayOf(draft.businessPaths),
      ...(envelope === undefined ? {} : { envelope }),
      http,
    },
  })
  for (const entry of entries.slice(0, MOCK_LIST_LIMIT)) {
    const { method, path, origin, query, provenance } = entry
    const responseObj = objectOf(entry.response)
    const status = responseObj?.status
    if (typeof method !== 'string' || typeof path !== 'string' || typeof status !== 'number') continue
    const rawBody = responseObj?.body
    const smallBody = rawBody !== undefined && JSON.stringify(rawBody).length <= 1024
    const response = { status, body: smallBody ? rawBody : FIXTURE_PLACEHOLDER }
    http.push({ method, path, response,
      ...(origin === undefined ? {} : { origin }), ...(query === undefined ? {} : { query }),
      ...(provenance === undefined ? {} : { provenance }) })
    if (snippet().length <= MOCK_SNIPPET_LIMIT) continue
    http.pop()
    break
  }
  if (http.length) lines.push('fixtureDraft.configSnippet (partial):', snippet())
  if (entries.length > http.length) lines.push(`  +${entries.length - http.length} draft entries omitted`)
  return lines
}

function renderCandidateList(label: string, items: JsonValue[]): string[] {
  if (!items.length) return []
  const lines = [label + ':']
  for (const entry of items) {
    const item = objectOf(entry)
    if (!item) continue
    const relation = arrayOf(item.relation).map(stringOf)
      .filter((value): value is string => value !== undefined).join(' -> ')
    const origin = stringOf(item.origin)
    lines.push(`  - ${fields(item, ['projectId'])} selector=${JSON.stringify(item.selector ?? null)} `
      + `evidence=${stringOf(item.evidence) ?? '?'}${origin ? ' origin=' + origin : ''}`
      + `${relation ? ' via ' + relation : ''}`)
  }
  return lines
}

function boundedJson(value: JsonValue, max: number): string {
  const text = JSON.stringify(value)
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

function locationLine(value: JsonValue): string | undefined {
  const item = objectOf(value)
  const file = stringOf(item?.file)
  if (!item || !file || typeof item.line !== 'number') return undefined
  const fieldsRead = arrayOf(item.fields).map(stringOf).filter(Boolean).join(', ')
  return `${file}:${item.line}` + (fieldsRead ? ` reads ${fieldsRead}` : '')
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
