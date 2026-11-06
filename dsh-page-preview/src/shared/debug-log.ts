/**
 * 结构化调试日志（review-2026-11-01 P2-8；R4 计划 R4-1，见 docs/r4-plan.md）。
 *
 * 取代 SessionRegistry / RunnerController 上只有测试能读的公共字段 `lastError`：
 *   - Host 与 Runner 各写自己的 JSONL 文件：<dataDir>/logs/host.jsonl、<dataDir>/logs/runner-<工作区哈希前 16 位>.jsonl
 *   - 每行 { at, level, scope, event, previewId?, code?, detail?, error? }；detail 与 error.message 经
 *     Redactor.text（与诊断同一脱敏策略），error 只记 name/message/经 Redactor.stack 截断的堆栈；
 *     不记录 env 值、命令参数、请求体。调用方须按条目归属传入 Redactor：可归属预览的用该预览的
 *     env 值与回传通道 nonce（与 RunnerSession.redactor 同源），无法归属的用全部存活会话的密钥
 *     并集（另加 start 目标项目的 env）；构造时只传入空 redactor 作为兜底，不代表真实密钥。
 *   - 大小上限 MAX_LOG_BYTES，超出时滚动为 .1（只保留一份旧文件），不无界增长
 *   - 写入失败只降级为不写（不得影响预览本身），available 反映最近一次写入是否成功；
 *     下一条面向 Agent 的意外失败诊断据此说明"调试日志不可用"
 *   - dataDir 缺失时 file 为 undefined，不写文件（此时插件本身已报配置缺失）
 *
 * 面向 Agent：意外失败诊断（session-registry 的 failure、controller 的 runtime_error）在 hint 中给出日志文件路径，
 * 让用户或 Agent 能执行"读取该文件"这一步（AGENTS.md §5 第 12 条）。
 * 导入本模块无副作用：文件只在首次 write 时创建。写入是同步小量追加——意外失败属稀有路径，不另起异步队列。
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'
import type { Redactor } from './redact.ts'

export const MAX_LOG_BYTES = 2 * 1024 * 1024

export type DebugLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DebugEntry {
  level: DebugLevel
  /** 'host' | 'runner' | 适配器 ID 等。 */
  scope: string
  /** 简短事件名，如 'open.failed'、'runner.exited'。 */
  event: string
  previewId?: string
  code?: string
  detail?: string
  error?: unknown
}

export interface DebugLog {
  /** 日志文件绝对路径；dataDir 缺失时为 undefined。 */
  readonly file: string | undefined
  /**
   * 不抛错；失败时记录到 available=false。
   * redactor 缺省用构造时的实例；调用方按条目归属覆盖——可归属预览的条目用该预览的
   * env 值与通道 nonce，无法归属的条目用全部存活会话的密钥并集。
   */
  write(entry: DebugEntry, redactor?: Redactor): void
  /** 最近一次写入是否成功（首次写入前为 true）。 */
  readonly available: boolean
}

/** Host 日志路径；dataDir 缺失或非绝对路径时为 undefined（配置缺失已另有诊断）。 */
export function hostLogFile(dataDir: string | undefined): string | undefined {
  if (dataDir === undefined || !isAbsolute(dataDir)) return undefined
  return join(dataDir, 'logs', 'host.jsonl')
}

/** Runner 日志路径：runner-<工作区 sha256 前 16 位>.jsonl（与 runnerPaths 同一哈希口径）。 */
export function runnerLogFile(dataDir: string, workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)
  return join(dataDir, 'logs', 'runner-' + key + '.jsonl')
}

export function createDebugLog(file: string | undefined, redactor: Redactor): DebugLog {
  let ok = true
  const log: DebugLog = {
    get file() { return file },
    get available() { return ok },
    write(entry, entryRedactor) {
      if (file === undefined) return
      try {
        const line = JSON.stringify(serialize(entry, entryRedactor ?? redactor)) + '\n'
        mkdirSync(dirname(file), { recursive: true })
        let size = 0
        try { size = statSync(file).size } catch { /* 文件不存在按 0 计；其它错误由 append 统一失败 */ }
        if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
          try { renameSync(file, file + '.1') } catch { /* 与 stat 竞态时文件可能已消失，append 重建 */ }
        }
        appendFileSync(file, line)
        ok = true
      } catch {
        ok = false
      }
    },
  }
  return log
}

/** 单行 JSON 形状；detail/error 过统一脱敏，其余字段限长。 */
function serialize(entry: DebugEntry, redactor: Redactor) {
  return {
    at: new Date().toISOString(),
    level: entry.level,
    scope: entry.scope,
    event: redactor.text(entry.event, 256),
    ...(entry.previewId === undefined ? {} : { previewId: redactor.text(entry.previewId, 128) }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.detail === undefined ? {} : { detail: redactor.text(entry.detail) }),
    ...(entry.error === undefined ? {} : { error: serializeError(entry.error, redactor) }),
  }
}

function serializeError(error: unknown, redactor: Redactor) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactor.text(error.message),
      ...(error.stack === undefined ? {} : { stack: redactor.stack(error.stack) }),
    }
  }
  return { message: redactor.text(String(error)) }
}
