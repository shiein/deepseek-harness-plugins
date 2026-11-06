/**
 * 响应包装线索的只读识别（R6-1d，`docs/r6-plan.md` §3 R6-1；方案 §7.2）。
 * 在源码中找"拦截器按成功码分支"的证据——同一接收者上 `X.code !== N` 失败分支与 `X.data`
 * 读取——据实给出 fixtureDraft.envelopeHint 的模板建议。只是建议，绝不自动写入场景；
 * 证据不全（只有 code 判断、没有 data 读取，或反之）就不给，不猜默认模板。
 *
 * 识别是确定性的行级匹配：只认 `<receiver>.code !== <整数>` 的失败分支写法与
 * `<receiver>.code === 0|200` 的成功码写法；`<receiver>` 是完整属性链（如 `res.data`、`body`），
 * data/msg/message 字段必须有同一接收者的真实引用。不推断变量命名，不做数据流分析。
 * 有界：扫描文件数与累计字节有上限，触顶即停；不读 .env*，不进 node_modules/dist 等排除目录
 * （scanProjectFiles 与 readProjectText 的既有边界）。片段可选经共享 redactor 脱敏后转发。
 */

import { relative } from 'node:path'
import { readProjectText } from '../shared/profile.ts'
import { scanProjectFiles } from '../shared/project-files.ts'
import type { EnvelopeHint } from '../shared/fixture-draft.ts'
import { ENVELOPE_DATA_TOKEN } from '../shared/envelope.ts'

/** 识别上限：文件数与累计源码字节；触顶即停（识别是建议性，不阻断 status）。 */
const HINT_MAX_FILES = 800
const HINT_MAX_BYTES = 512 * 1024
/** 单文件超过该字节数跳过：请求层模块不会这么大。 */
const HINT_MAX_FILE_BYTES = 96 * 1024
const HINT_SOURCE = /\.(?:[cm]?[jt]sx?|vue)$/
/** 证据片段上限（字符），转发给 Agent 前再经 redactor 限长。 */
const SNIPPET_LIMIT = 160

/**
 * `receiver.code !== <int>` 或 `receiver.code === 0|200`；receiver 为完整属性链。
 * `!==` 视作失败分支（字面量即成功码）；`===` 只认 0/200 两种惯例成功码，避免把
 * 失败码比较（如 `=== 500`）误当成功码。
 */
const CODE_CHECK = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.code\s*(!==|===)\s*(?:"(\d+)"|'(\d+)'|(\d+))\b/g

export interface EnvelopeHintOptions {
  /** 已配置的文件数/字节上限覆盖（测试用）。 */
  files?: number
  bytes?: number
  /** 片段脱敏（共享 redactor 的 text）；缺省时只截断。 */
  redact?: (text: string, limit?: number) => string
}

/**
 * 只读扫描 appRoot 下源码，返回包装线索建议；无证据或触顶前无命中返回 undefined。
 * 扫描顺序固定（文件名排序），结果与目录枚举顺序无关。
 */
export async function collectEnvelopeHint(appRoot: string,
  options: EnvelopeHintOptions = {}): Promise<EnvelopeHint | undefined> {
  const { files } = await scanProjectFiles(appRoot, options.files ?? HINT_MAX_FILES)
  let bytes = 0
  for (const file of [...files].sort()) {
    if (!HINT_SOURCE.test(file)) continue
    const text = await readProjectText(file, appRoot).catch(() => undefined)
    if (text === undefined || text.length > HINT_MAX_FILE_BYTES) continue
    bytes += text.length
    if (bytes > (options.bytes ?? HINT_MAX_BYTES)) break
    const hint = detectInFile(relative(appRoot, file), text, options)
    if (hint !== undefined) return hint
  }
  return undefined
}

/** 单文件内的确定性识别：同一 receiver 上 code 判断 + data 读取都成立才给建议。 */
function detectInFile(file: string, text: string, options: EnvelopeHintOptions): EnvelopeHint | undefined {
  const lines = text.split('\n')
  const snippet = (line: number) => {
    const raw = (lines[line - 1] ?? '').trim().slice(0, SNIPPET_LIMIT)
    return options.redact ? options.redact(raw, SNIPPET_LIMIT) : raw
  }
  const evidence: EnvelopeHint['evidence'] = []
  let code: number | string | undefined
  let receiver: string | undefined
  for (const match of text.matchAll(CODE_CHECK)) {
    const [, owner, operator, dq, sq, num] = match
    if (owner === undefined || operator === undefined) continue
    const literal = num ?? dq ?? sq
    if (literal === undefined) continue
    // === 只认 0/200 惯例成功码；!== 接受任意整数字面量（失败分支写法）。
    if (operator === '===' && literal !== '0' && literal !== '200') continue
    const line = text.slice(0, match.index).split('\n').length
    evidence.push({ file, line, snippet: snippet(line) })
    code = num !== undefined ? Number(num) : literal
    receiver = owner
    if (evidence.length >= 2) break
  }
  if (receiver === undefined || code === undefined) return undefined
  const field = new RegExp('\\b' + receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(data|msg|message)\\b', 'g')
  let data: string | undefined
  let message: string | undefined
  for (const match of text.matchAll(field)) {
    const line = text.slice(0, match.index).split('\n').length
    if (match[1] === 'data' && data === undefined) {
      data = 'data'
      evidence.push({ file, line, snippet: snippet(line) })
    } else if (match[1] !== 'data' && message === undefined) {
      message = match[1]
      evidence.push({ file, line, snippet: snippet(line) })
    }
    if (evidence.length >= 4) break
  }
  if (data === undefined) return undefined
  const template: Record<string, unknown> = { code }
  if (message !== undefined) template[message] = 'ok'
  template.data = ENVELOPE_DATA_TOKEN
  return { template, evidence }
}
