/** 最小预览面板 body（方案 §10）：会话状态流驱动；停止按钮走与工具相同的 owner 路径。 */
import { createElement, useEffect, useState } from 'react'
import type { PanelController } from './view-model.ts'
import type { PanelSnapshot } from './protocol.ts'
import { readinessLabel, stoppable } from './view-model.ts'
import { suggestionRows, unmatchedRows } from './suggestions.ts'

/** props 由 slots register 的 inject(controller) 与框架(locale/store/hooks)合并提供。 */
export interface PreviewPanelProps extends PanelController {
  t?: (key: string) => string
}

// 颜色只用 DSH 主题变量（含非 DSH 宿主下的回退值），保证浅色/深色主题均可读。
const styles = {
  section: { padding: '8px 10px', fontSize: '12px', lineHeight: '1.5', overflowY: 'auto' as const,
    color: 'var(--dsw-alias-label-primary, inherit)' },
  header: { fontWeight: 600, marginBottom: '6px' },
  meta: { color: 'var(--dsw-alias-label-secondary, #888)', overflowWrap: 'anywhere' as const },
  item: { listStyle: 'none', margin: '0 0 8px', padding: '0 0 8px',
    borderBottom: '1px solid var(--dsw-alias-border-l3, #3333)' },
  badge: { marginLeft: '6px', padding: '0 4px', border: '1px solid var(--dsw-alias-border-l2, #8886)',
    borderRadius: 'var(--dsw-radius-sm, 3px)' },
  button: { marginTop: '4px', cursor: 'pointer', color: 'var(--dsw-alias-label-primary, inherit)',
    background: 'var(--dsw-alias-button-elevated-fill, transparent)',
    border: '1px solid var(--dsw-alias-border-l2, #8886)', borderRadius: 'var(--dsw-radius-sm, 3px)',
    padding: '1px 8px' },
  link: { marginTop: '4px', padding: 0, border: 'none', background: 'none', cursor: 'pointer', font: 'inherit',
    color: 'var(--dsw-alias-link, #4daafc)', textAlign: 'left' as const, overflowWrap: 'anywhere' as const },
  error: { color: 'var(--dsw-alias-state-error-primary, #c66)', overflowWrap: 'anywhere' as const },
  diag: { margin: '8px 0 0', paddingLeft: '16px', color: 'var(--dsw-alias-state-warn-tertiary, #a80)' },
} as const

export function PreviewPanel(props: PreviewPanelProps) {
  const t = props.t ?? ((key: string) => key)
  const [snapshot, setSnapshot] = useState<PanelSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    const control = new AbortController()
    const stream = props.follow(control.signal)
    void (async () => {
      try {
        for await (const item of stream) if (!control.signal.aborted) setSnapshot(item)
      } catch (failure) {
        if (!control.signal.aborted) setError(String(failure))
      }
    })()
    return () => { control.abort(); stream.dispose() }
  }, [props.follow])
  const e = createElement
  return e('section', { style: styles.section },
    e('div', { style: styles.header }, t('title')),
    error === undefined ? null : e('p', { style: styles.error }, error),
    snapshot === undefined ? e('p', null, t('loading'))
      : snapshot.previews.length === 0 ? e('p', null, t('empty'))
      : e('ul', { style: { margin: 0, padding: 0 } }, snapshot.previews.map(preview => e('li', { key: preview.previewId, style: styles.item },
          e('div', null,
            e('strong', null, preview.targetId),
            e('span', { style: styles.badge }, preview.state),
            e('span', { style: styles.badge }, preview.freshness)),
          e('div', { style: styles.meta }, [preview.projectId, preview.scope, preview.strategy, readinessLabel(preview)].join(' · ') + (preview.scenario === undefined ? '' : ' · ' + preview.scenario)),
          preview.url === undefined ? null : e('div', null, e('button', {
            style: styles.link,
            title: t('openInBrowser'),
            onClick: () => props.openInBrowser(preview.url!),
          }, preview.url)),
          preview.capabilityGaps.length === 0 ? null : e('div', { style: styles.meta }, preview.capabilityGaps.map(gap => gap.name + ':' + gap.status).join(', ')),
          stoppable(preview.state) ? e('button', {
            style: styles.button,
            onClick: () => void props.stop(preview.previewId).then(reply => { if (!reply.ok) setError(reply.error.message) }),
          }, t('stop')) : null))),
    // R5-6（D2-b）：建议候选可一键打开——点击即授权意图；执行指纹审批仍在 Host
    // 经官方弹窗请求，面板不建第二份事实源也不跳过审批。
    snapshot === undefined ? null : (() => {
      const rows = suggestionRows(snapshot.suggestions)
      return rows.length === 0 && snapshot.suggestionsOmitted === undefined ? null : e('div', null,
        e('div', { style: styles.header }, t('suggestions')),
        e('ul', { style: styles.diag }, rows.map((row, index) => e('li', { key: index },
          e('div', null,
            e('span', null, row.label),
            e('span', { style: styles.badge }, row.evidence),
            row.origin === undefined ? null : e('span', { style: styles.badge }, row.origin)),
          row.relation === '' ? null : e('div', { style: styles.meta }, row.relation),
          row.open === undefined ? null : e('button', {
            style: styles.button,
            onClick: () => void props.open(row.open!).then(reply => {
              if (!reply.ok) { setError(reply.error.message); return }
              if (reply.value.status !== 'ok') {
                setError(reply.value.diagnostics.map(value => value.message).join('; ') || reply.value.status)
              }
            }),
          }, t('openSuggestion'))))),
        snapshot.suggestionsOmitted === undefined || snapshot.suggestionsOmitted === 0 ? null
          : e('div', { style: styles.meta }, '+' + snapshot.suggestionsOmitted + ' ' + t('suggestionsOmitted')))
    })(),
    snapshot === undefined ? null : (() => {
      const rows = unmatchedRows(snapshot.previews)
      return rows.length === 0 ? null : e('div', null,
        e('div', { style: styles.header }, t('unmatched')),
        e('ul', { style: styles.diag }, rows.map((row, index) => e('li', { key: index },
          e('span', null, row.label),
          e('span', { style: styles.badge }, '×' + row.count)))),
        e('div', { style: styles.meta }, t('unmatchedHint')))
    })(),
    snapshot === undefined || snapshot.diagnostics.length === 0 ? null : e('div', null,
      e('div', { style: styles.header }, t('diagnostics')),
      e('ul', { style: styles.diag }, snapshot.diagnostics.map((value, index) => e('li', { key: index }, '[' + value.code + '] ' + value.message)))))
}
