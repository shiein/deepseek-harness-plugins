/**
 * 从 tools/result 中提取 Agent 写入的路径（方案 §5.3；R3 计划 R3-4）。
 *
 * Phase 0 实测（docs/phase0-verification.md:44）：写工具的 exec.arguments.file_path 保留调用时的相对输入，
 * result.meta.path 为规范化的绝对路径。规则：
 *   - 只认白名单中的写文件工具名（WRITE_TOOL_NAMES）；shell/bash 等命令不按文本推断写入路径
 *   - 工具结果失败（result 表示错误）时不记录
 *   - 优先 meta.path；缺失时按调用时工作目录解析 arguments 中的路径
 *   - 解析结果必须位于工作区内（真实路径核对），否则丢弃
 * 返回值只作为 agent-confirmed 来源标签的证据，不单独决定"有变化"——内容是否变化仍由 diffBaseline 判定。
 */

import { isAbsolute, resolve } from 'node:path'
import { canonicalPath, isWithinRoot } from '../../shared/config/paths.ts'

/**
 * 写文件类工具名白名单。依据（2026-11-03，Claude 复核）：Aesc 本机 DSH 0.2.1-rc.5 的 80 个真实会话日志中，
 * 写文件工具只有 `write`（46 次）与 `search_replace`（461 次），参数均为 `file_path`；
 * `edit`/`apply_patch`/`str_replace_editor` 从未出现。内置工具不随 npm 类型定义发布，新增前先用会话日志核实。
 */
export const WRITE_TOOL_NAMES: readonly string[] = ['write', 'search_replace']

export interface ToolWriteEvidence {
  toolName: string
  /** exec.arguments，结构未知，逐字段做类型收窄。 */
  args: unknown
  /** result.meta，结构未知。 */
  meta: unknown
  /** 结果是否成功（由调用方从 ToolExecutionResult 判定）。 */
  ok: boolean
  /** 调用时的有效工作目录（ctx.workingDirectory.get(session)）。 */
  cwd: string
}

/** 只用已核实的字段：arguments.file_path（会话日志与 Phase 0）、meta.path（Phase 0）。 */
function stringField(value: unknown, field: string): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' && candidate.trim() ? [candidate] : []
}

/** 返回工作区内的绝对路径；不是写工具、失败或越界时返回空数组。 */
export async function extractWrittenPaths(evidence: ToolWriteEvidence, workspaceRoot: string): Promise<string[]> {
  if (!evidence.ok || !WRITE_TOOL_NAMES.includes(evidence.toolName)) return []
  const workspace = await canonicalPath(workspaceRoot)
  const candidates = [...stringField(evidence.meta, 'path'), ...stringField(evidence.args, 'file_path')]
  const written: string[] = []
  for (const candidate of candidates) {
    const target = isAbsolute(candidate) ? candidate : resolve(evidence.cwd, candidate)
    let canonical: string
    try { canonical = await canonicalPath(target) }
    catch { continue } // 断链/不可解析的路径不构成写入证据。
    if (isWithinRoot(workspace, canonical) && !written.includes(canonical)) written.push(canonical)
  }
  return written
}
