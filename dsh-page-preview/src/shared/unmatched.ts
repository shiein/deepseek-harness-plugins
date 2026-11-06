/**
 * 未命中请求的模型可见汇总类型（方案 §7.2、§13 第 8 条；R3 计划 R3-1）。
 * 由 Runner 经 IPC/状态快照转发到 Host status 与面板；shared 层不 import 其他模块。
 * 只保留 method/origin/path 与 query 键名：query 值、请求体、headers、凭据一律不出现。
 */

export interface UnmatchedRequestEntry {
  method: string
  /** 跨源请求的原 origin；同源时缺失。 */
  origin?: string
  /** 只含 pathname，不含 query。 */
  path: string
  /** 观察到的 query 键名（去重、排序），不含值。 */
  queryKeys: string[]
  count: number
  /** ISO 8601 */
  firstSeen: string
  lastSeen: string
}

export interface UnmatchedSnapshot {
  entries: UnmatchedRequestEntry[]
  /** 因上限未记录的不同键数量。 */
  dropped: number
  /**
   * R6-4：最近一次"新增未命中键"的 ISO 时间（重复计数不算新增）。
   * 供 Host 在输出时换算成 sinceLastNewEntryMs。
   */
  lastNewEntryAt?: string
  /**
   * R6-4：Host 在 status 输出时计算的"距最近一次新增未命中条目的毫秒数"；
   * Agent 据此判断首屏请求是否已发完——值仍在增长时稍后再调一次 status。
   */
  sinceLastNewEntryMs?: number
  /** R6-4：status detail 输出附带的可执行下一步提示（Host 附加，不经 IPC）。 */
  hint?: string
}
