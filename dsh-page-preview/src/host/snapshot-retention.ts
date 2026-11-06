/**
 * Host 侧预览缓存的保留策略（review-2026-11-01 P2-9；R4 计划 R4-2）。纯函数，无 I/O。
 *
 * 现状：runner-client.ts 的 snapshots、diagnostics 两个 Map 按 previewId 只增不减（bindings 只在启动失败时删除），
 * 而每次 open 都产生新的 previewId，长会话中持续增长。
 *
 * 约束（不得破坏既有行为）：
 *   - 非终态预览一律保留
 *   - 终态（stopped / failed）预览仍需能被 status 按 ID 单查（方案 §4.2"旧 ID 仍可单查"），因此不是立即删除，
 *     而是每个 owner 只保留最近 MAX_TERMINAL_PER_OWNER 个终态，超出的最旧者连同 bindings/diagnostics 一起删除
 *   - cleanup_failed 视为非终态（仍需用户恢复），保留
 *   - 被删除的 ID 再查询返回 not_found，与"未知 ID"一致，不伪造 stopped
 */

export const MAX_TERMINAL_PER_OWNER = 16

export interface RetainedPreview {
  previewId: string
  owner: string
  state: string
  /** 进入终态的时间（epoch ms）；非终态缺失。 */
  terminalAt?: number
}

/** Host 视为终态的状态；cleanup_failed 仍需恢复入口，不算终态。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['stopped', 'failed'])

/**
 * 返回应删除的 previewId：每个 owner 只保留最近 limit 个终态预览，超出的最旧者被回收。
 * 输入顺序无关，输出按"进入终态由近到远"排序后取尾部，结果确定。
 */
export function previewsToEvict(previews: readonly RetainedPreview[], limit = MAX_TERMINAL_PER_OWNER): string[] {
  const terminalByOwner = new Map<string, RetainedPreview[]>()
  for (const preview of previews) {
    if (!TERMINAL_STATES.has(preview.state)) continue
    const list = terminalByOwner.get(preview.owner) ?? []
    list.push(preview)
    terminalByOwner.set(preview.owner, list)
  }
  const evict: string[] = []
  for (const list of terminalByOwner.values()) {
    if (list.length <= limit) continue
    const recentFirst = [...list].sort(compareTerminalRecency)
    for (const preview of recentFirst.slice(Math.max(0, limit))) evict.push(preview.previewId)
  }
  return evict
}

/** 进入终态越近越靠前；terminalAt 缺失视为最旧，时间相同按 previewId 保证确定性。 */
function compareTerminalRecency(a: RetainedPreview, b: RetainedPreview): number {
  const at = a.terminalAt ?? Number.NEGATIVE_INFINITY
  const bt = b.terminalAt ?? Number.NEGATIVE_INFINITY
  return bt - at || a.previewId.localeCompare(b.previewId)
}
