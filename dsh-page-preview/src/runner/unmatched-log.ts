/**
 * 每个预览的未命中请求汇总（方案 §7.2、§13 第 8 条；R3 计划 R3-1）。Runner 基础设施，只依赖 shared。
 *
 * 来源：适配器 emit 的 unmatched 事件（Vue worker 的 http-diagnostic 已带 method/origin/path/queryKeys）。
 * 汇总键：(origin ?? 同源, method 大写, pathname)。query 只保留"键名集合"，不保留值；
 * 请求体、headers、Cookie 一律不记录（§13 第 8 条：转发 Agent 修复需要的 method/origin/path，凭据必须去除）。
 * 上限：每个预览最多 MAX_UNMATCHED 个不同键，超出只累加 dropped，不无界增长。
 * 场景切换或 fixture 重新加载（R3-2）后清空，避免把旧场景的缺口算到新场景。
 */

import type { UnmatchedRequestEntry, UnmatchedSnapshot } from '../shared/unmatched.ts'

export const MAX_UNMATCHED = 64

export class UnmatchedRequestLog {
  private readonly entries = new Map<string, UnmatchedRequestEntry>()
  private dropped = 0
  /** R6-4：最近一次新增键的时间；重复计数不更新（Agent 用它判断未命中列表是否稳定）。 */
  private lastNewAt: Date | undefined

  /**
   * 入参已在上游脱敏（无 query 值/请求体/headers）；本处再做防御性规范化：
   * method 大写，path 只保留 pathname，origin 只接受无 userinfo 的 http(s) 来源；无法规范化的输入丢弃。
   */
  record(
    request: { method: string; origin?: string; path: string; queryKeys?: readonly string[] },
    at: Date = new Date(),
  ): void {
    const method = request.method.trim().toUpperCase()
    if (!method || method.length > 16 || /[\s/]/.test(method)) return
    const path = normalizePath(request.path)
    if (path === undefined) return
    const origin = request.origin === undefined ? undefined : normalizeOrigin(request.origin)
    if (request.origin !== undefined && origin === undefined) return
    const key = (origin ?? '') + ' ' + method + ' ' + path
    const seen = at.toISOString()
    const queryKeys = [...new Set(
      (request.queryKeys ?? []).filter(key => typeof key === 'string' && key.length > 0 && key.length <= 256),
    )].sort()
    const existing = this.entries.get(key)
    if (existing) {
      existing.count += 1
      existing.lastSeen = seen
      if (queryKeys.length > existing.queryKeys.length) existing.queryKeys = queryKeys
      return
    }
    if (this.entries.size >= MAX_UNMATCHED) {
      this.dropped += 1
      return
    }
    this.entries.set(key, {
      method, ...(origin === undefined ? {} : { origin }), path, queryKeys,
      count: 1, firstSeen: seen, lastSeen: seen,
    })
    this.lastNewAt = at
  }

  snapshot(): UnmatchedSnapshot {
    return {
      entries: [...this.entries.values()].map(entry => ({ ...entry, queryKeys: [...entry.queryKeys] })),
      dropped: this.dropped,
      ...(this.lastNewAt === undefined ? {} : { lastNewEntryAt: this.lastNewAt.toISOString() }),
    }
  }

  clear(): void {
    this.entries.clear()
    this.dropped = 0
    this.lastNewAt = undefined
  }
}

/** 只接受绝对 pathname；相对输入按 '/' 前缀尝试解析，畸形或含 query 值痕迹的输入丢弃。 */
function normalizePath(path: string): string | undefined {
  if (typeof path !== 'string' || !path || path.length > 4096) return undefined
  const raw = path.split('?')[0]!.split('#')[0]!
  if (!raw.startsWith('/')) return undefined
  return raw
}

/** 只接受无凭据的 http(s) origin；其他输入视为无效跨源记录。 */
function normalizeOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    return url.origin
  } catch { return undefined }
}
