/** 面板建议与未命中区块（方案 §10；R3-6）：行投影、空状态、协议上限与"只展示不打开"。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { suggestionRows, unmatchedRows } from '../../src/client/suggestions.ts'
import { panelSnapshotSchema } from '../../src/client/protocol.ts'
import type { PanelPreview } from '../../src/client/protocol.ts'

const preview = (overrides: Partial<PanelPreview> = {}): PanelPreview => ({
  previewId: 'p1', projectId: 'web', targetId: 'orders', scope: 'page', strategy: 'project',
  state: 'ready', freshness: 'current', capabilityGaps: [],
  readiness: {
    serviceReachable: { status: 'proven' }, documentLoaded: { status: 'proven' },
    targetMounted: { status: 'proven' },
  },
  ...overrides,
})

test('suggestionRows projects relation chains and evidence; empty or absent input stays empty', () => {
  assert.deepEqual(suggestionRows(undefined), [])
  assert.deepEqual(suggestionRows([]), [])
  const rows = suggestionRows([
    { projectId: 'web', selector: 'file src/pages/Settings.vue', evidence: 'medium',
      relation: ['src/styles/app.css', 'src/pages/Settings.vue'], origin: 'workspace-observed' },
    { projectId: 'admin', selector: 'registered main', relation: ['src/main.ts'], evidence: 'strong' },
  ])
  assert.deepEqual(rows, [
    { label: 'web · file src/pages/Settings.vue', relation: 'src/styles/app.css → src/pages/Settings.vue',
      evidence: 'medium', origin: 'workspace-observed' },
    { label: 'admin · registered main', relation: 'src/main.ts', evidence: 'strong' },
  ])
  // 展示行不携带可执行动作字段：打开需要 Agent 工具调用与审批上下文（D2）。
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(),
    row.origin === undefined ? ['evidence', 'label', 'relation'] : ['evidence', 'label', 'origin', 'relation'])
})

test('unmatchedRows keeps only previews with misses, sorts by count and folds dropped into the label', () => {
  const rows = unmatchedRows([
    preview({ targetId: 'quiet' }),
    preview({ targetId: 'busy', unmatchedCount: 7, unmatchedDropped: 2 }),
    preview({ targetId: 'single', unmatchedCount: 1 }),
    preview({ targetId: 'dropped-only', unmatchedDropped: 5 }),
  ])
  assert.deepEqual(rows, [
    { label: 'busy (+2 dropped)', count: 7 },
    { label: 'single', count: 1 },
    { label: 'dropped-only (+5 dropped)', count: 0 },
  ])
})

test('panelSnapshotSchema accepts honest snapshots and rejects bounds violations and extra keys', () => {
  const base = {
    previews: [preview()], diagnostics: [],
    suggestions: [{ projectId: 'web', selector: 'file x.vue', relation: ['a.css'], evidence: 'strong' }],
    suggestionsOmitted: 2,
  }
  const parsed = panelSnapshotSchema.parse(base)
  assert.equal(parsed.suggestions![0]!.evidence, 'strong')
  // 建议上限 3、预览上限 64、关系链上限 12——超限与未知键都拒绝，不静默截断。
  assert.equal(panelSnapshotSchema.safeParse({ ...base,
    suggestions: [...Array(4)].map(() => base.suggestions[0]) }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ ...base,
    previews: [...Array(65)].map(() => preview()) }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ ...base,
    suggestions: [{ ...base.suggestions[0], relation: [...Array(13)].map((_, i) => 'r' + i) }] }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ ...base, open: 'page_preview_open' }).success, false)
  assert.equal(panelSnapshotSchema.safeParse({ ...base,
    previews: [{ ...preview(), unmatchedCount: -1 }] }).success, false)
  // 缺省可选字段：未分析过/未命中的快照同样合法。
  assert.equal(panelSnapshotSchema.safeParse({ previews: [], diagnostics: [] }).success, true)
})

test('the suggestions panel block binds only the panel-remote open, never a tool or raw URL open', async () => {
  // 结构性核对（R5-6，D2-b）：建议行的打开动作只能调用 props.open（Host 远程方法，
  // 复用工具 open 的审批与 owner 链路）；不得出现 openInBrowser 或任何就地执行路径。
  const source = await readFile(fileURLToPath(new URL('../../src/client/panel.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('const rows = suggestionRows(')
  const block = source.slice(start, source.indexOf('})()', start))
  assert.ok(block.includes('suggestionRows'), 'suggestions block must render suggestion rows')
  assert.ok(block.includes('props.open(row.open!)'), 'suggestion open must go through the panel remote')
  assert.equal(block.includes('openInBrowser'), false, 'suggestions must not deep-link a raw URL')
})
