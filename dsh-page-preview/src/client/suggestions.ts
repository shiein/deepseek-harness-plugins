/**
 * 面板"建议预览"与"未命中请求"区块的纯逻辑（方案 §10；R3 计划 R3-6）。不依赖 React，可独立单测。
 *
 * 展示规则：
 *   - 建议：最多 3 条，显示关系链（如"样式 → 设置页面"）、证据强度与来源标签；不提供"一键打开"
 *     （打开需要 Agent 工具调用与执行审批上下文，D2 未决前面板只展示）
 *   - 未命中请求：按次数排序的 method + origin + path，附"fixture 草稿可经 page_preview_status detail 获取"的说明
 *   - 两者都只来自 Host 已投影、与 status 同口径的数据；不建立独立事实源（§10 最后一条）
 *
 * 协议字段：panelSnapshotSchema 的 suggestions / suggestionsOmitted / previews[].unmatchedCount /
 * previews[].unmatchedDropped，均由 Host 侧 session-registry.panelSnapshot 填充并设长度上限。
 */

import type { PanelPreview, PanelSuggestion, PanelSuggestionOpen } from './protocol.ts'

export interface SuggestionRow {
  label: string
  relation: string
  evidence: 'strong' | 'medium' | 'weak'
  origin?: string
  /** R5-6：一键打开的原始载荷；缺省时行只展示。 */
  open?: PanelSuggestionOpen
}

export interface UnmatchedRow {
  label: string
  count: number
}

/** 建议行：projectId · selector 摘要 + 关系链 + 证据强度 + 来源标签；未分析过返回空数组。 */
export function suggestionRows(suggestions: readonly PanelSuggestion[] | undefined): SuggestionRow[] {
  return (suggestions ?? []).map(value => ({
    label: value.projectId + ' · ' + value.selector,
    relation: value.relation.join(' → '),
    evidence: value.evidence,
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    ...(value.open === undefined ? {} : { open: value.open }),
  }))
}

/** 每个预览的未命中计数行（按计数降序）；dropped 以 (+N dropped) 后缀并入 label。 */
export function unmatchedRows(previews: readonly PanelPreview[]): UnmatchedRow[] {
  return previews.filter(preview => (preview.unmatchedCount ?? 0) > 0 || (preview.unmatchedDropped ?? 0) > 0)
    .map(preview => ({
      label: preview.targetId
        + (preview.unmatchedDropped ? ' (+' + preview.unmatchedDropped + ' dropped)' : ''),
      count: preview.unmatchedCount ?? 0,
    }))
    .sort((a, b) => b.count - a.count)
}
