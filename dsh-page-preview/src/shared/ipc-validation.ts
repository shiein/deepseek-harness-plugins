/** Runner → Host 的 IPC 数据边界（方案 §6.5、§9.2）；严格校验形状，不从确认消息推断就绪。 */
import type { Diagnostic, Evidence, PageTextObservation, ReadinessEvidence } from './contracts.ts'
import { PAGE_TEXT_LIMIT } from './contracts.ts'
import type { RunnerReply, RunnerSnapshot, RunnerToHost } from './ipc.ts'
import { isSessionState } from './state-machine.ts'
import type { UnmatchedRequestEntry, UnmatchedSnapshot } from './unmatched.ts'

export function parseRunnerMessage(value: unknown): RunnerToHost {
  const message = record(value)
  switch (message.type) {
    case 'ready-for-commands': {
      fields(message, ['type', 'pid'], ['node'])
      if (typeof message.pid !== 'number' || !Number.isSafeInteger(message.pid) || message.pid < 1) invalid()
      const node = message.node === undefined ? undefined : record(message.node)
      if (node) fields(node, ['executable', 'version'])
      return { type: 'ready-for-commands', pid: message.pid, ...(node ? { node: { executable: id(node.executable), version: id(node.version) } } : {}) }
    }
    case 'ack': {
      fields(message, ['type', 'requestId', 'ok'], ['diagnostics', 'result'])
      if (typeof message.ok !== 'boolean') invalid()
      const result = message.result === undefined ? undefined : reply(message.result)
      if (result && message.ok !== (result.status === 'ok')) invalid()
      return { type: 'ack', requestId: id(message.requestId), ok: message.ok, ...(message.diagnostics === undefined ? {} : { diagnostics: array(message.diagnostics).map(diagnostic) }), ...(result === undefined ? {} : { result }) }
    }
    case 'diagnostic':
      fields(message, ['type', 'previewId', 'diagnostic'])
      return { type: 'diagnostic', previewId: id(message.previewId), diagnostic: diagnostic(message.diagnostic) }
    case 'stopped':
      fields(message, ['type', 'previewId', 'residual'])
      return { type: 'stopped', previewId: id(message.previewId), residual: array(message.residual).map(text) }
    case 'channel-secrets':
      fields(message, ['type', 'previewId', 'secrets'])
      return { type: 'channel-secrets', previewId: id(message.previewId),
        secrets: array(message.secrets).map(text) }
    case 'state': {
      fields(message, ['type', 'previewId', 'state', 'freshness', 'readiness'],
        ['url', 'pageText', 'unmatched', 'scenario'])
      if (!isSessionState(message.state)) invalid()
      return {
        type: 'state', previewId: id(message.previewId), state: message.state,
        freshness: choice(message.freshness, ['current', 'stale', 'unverified']),
        readiness: readiness(message.readiness),
        ...(message.url === undefined ? {} : { url: text(message.url) }),
        ...(message.pageText === undefined ? {} : { pageText: pageText(message.pageText) }),
        ...(message.unmatched === undefined ? {} : { unmatched: unmatched(message.unmatched) }),
        ...(message.scenario === undefined ? {} : { scenario: id(message.scenario) }),
      }
    }
    default: return invalid()
  }
}

function reply(value: unknown): RunnerReply {
  const item = record(value)
  fields(item, ['status'], ['previewId', 'previews', 'residual', 'occupant', 'takenOver'])
  const result: RunnerReply = { status: choice(item.status, ['ok', 'needs_selection', 'needs_configuration', 'unsupported', 'not_found', 'busy', 'error']) }
  if (item.previewId !== undefined) result.previewId = id(item.previewId)
  if (item.residual !== undefined) result.residual = array(item.residual).map(text)
  if (item.takenOver !== undefined) result.takenOver = id(item.takenOver)
  if (item.occupant !== undefined) {
    const occupant = record(item.occupant)
    fields(occupant, ['previewId', 'state', 'projectId', 'targetId', 'sameOwner'])
    if (!isSessionState(occupant.state) || typeof occupant.sameOwner !== 'boolean') invalid()
    result.occupant = { previewId: id(occupant.previewId), state: occupant.state, projectId: id(occupant.projectId), targetId: id(occupant.targetId), sameOwner: occupant.sameOwner }
  }
  if (item.previews !== undefined) result.previews = array(item.previews).map(value => {
    const snapshot = record(value)
    fields(snapshot, ['previewId', 'state', 'freshness', 'readiness'], ['url', 'pageText', 'unmatched', 'scenario'])
    const message = parseRunnerMessage({ ...snapshot, type: 'state' })
    if (message.type !== 'state') return invalid()
    const { type: _type, ...parsed } = message
    return parsed satisfies RunnerSnapshot
  })
  return result
}

/** 未命中汇总边界：64 条、每条约 32 个 query 键名、单字段限长；条数不得伪造。 */
function unmatched(value: unknown): UnmatchedSnapshot {
  const item = record(value)
  fields(item, ['entries', 'dropped'], ['lastNewEntryAt'])
  const entries = array(item.entries)
  if (entries.length > 64) invalid()
  const dropped = item.dropped
  if (typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0 || dropped > 1_000_000) invalid()
  const lastNewEntryAt = item.lastNewEntryAt === undefined ? undefined : text(item.lastNewEntryAt)
  if (lastNewEntryAt !== undefined && !Number.isFinite(Date.parse(lastNewEntryAt))) invalid()
  return { entries: entries.map(unmatchedEntry), dropped,
    ...(lastNewEntryAt === undefined ? {} : { lastNewEntryAt }) }
}

function unmatchedEntry(value: unknown): UnmatchedRequestEntry {
  const item = record(value)
  fields(item, ['method', 'path', 'queryKeys', 'count', 'firstSeen', 'lastSeen'], ['origin'])
  const method = text(item.method), path = text(item.path)
  if (!method || method.length > 16 || !path.startsWith('/') || path.length > 4096) invalid()
  const keys = array(item.queryKeys).map(text)
  if (keys.length > 32 || keys.some(key => key.length > 256)) invalid()
  const count = item.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) invalid()
  const firstSeen = text(item.firstSeen), lastSeen = text(item.lastSeen)
  if (!Number.isFinite(Date.parse(firstSeen)) || !Number.isFinite(Date.parse(lastSeen))) invalid()
  const origin = item.origin === undefined ? undefined : text(item.origin)
  if (origin !== undefined && origin.length > 4096) invalid()
  return { method, ...(origin === undefined ? {} : { origin }), path, queryKeys: keys, count, firstSeen, lastSeen }
}

function pageText(value: unknown): PageTextObservation {
  const item = record(value)
  fields(item, ['text', 'url', 'truncated', 'receivedAt'])
  const content = text(item.text), url = text(item.url), receivedAt = text(item.receivedAt)
  if (content.length > PAGE_TEXT_LIMIT || url.length > 16_384 || typeof item.truncated !== 'boolean' || !Number.isFinite(Date.parse(receivedAt))) invalid()
  return { text: content, url, truncated: item.truncated, receivedAt }
}

function readiness(value: unknown): ReadinessEvidence {
  const item = record(value)
  fields(item, ['serviceReachable', 'documentLoaded', 'targetMounted'])
  return { serviceReachable: evidence(item.serviceReachable), documentLoaded: evidence(item.documentLoaded), targetMounted: evidence(item.targetMounted) }
}

function evidence(value: unknown): Evidence {
  const item = record(value)
  fields(item, ['status'], ['detail', 'at'])
  return { status: choice(item.status, ['proven', 'failed', 'unverified']), ...(item.detail === undefined ? {} : { detail: text(item.detail) }), ...(item.at === undefined ? {} : { at: text(item.at) }) }
}

function diagnostic(value: unknown): Diagnostic {
  const item = record(value)
  fields(item, ['code', 'phase', 'message'], ['hint', 'previewId', 'location'])
  const result: Diagnostic = {
    code: id(item.code),
    phase: choice(item.phase, ['resolve', 'detect', 'plan', 'start', 'ready', 'update', 'scenario', 'capture', 'stop', 'config', 'ledger']),
    message: text(item.message),
  }
  if (item.hint !== undefined) result.hint = text(item.hint)
  if (item.previewId !== undefined) result.previewId = id(item.previewId)
  if (item.location !== undefined) {
    const location = record(item.location)
    fields(location, [], ['file', 'line', 'request'])
    result.location = {}
    if (location.file !== undefined) result.location.file = text(location.file)
    if (location.request !== undefined) result.location.request = text(location.request)
    if (location.line !== undefined) {
      if (typeof location.line !== 'number' || !Number.isSafeInteger(location.line) || location.line < 1) invalid()
      result.location.line = location.line
    }
  }
  return result
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid()
}
function text(value: unknown): string { if (typeof value !== 'string') invalid(); return value }
function id(value: unknown): string { const result = text(value); if (!result) invalid(); return result }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) invalid(); return value }
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  const match = values.find(item => item === value)
  return match ?? invalid()
}
function invalid(): never { throw new Error('Invalid Runner IPC message') }
