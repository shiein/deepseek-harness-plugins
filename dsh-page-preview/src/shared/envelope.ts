/**
 * 场景级响应包装的数据定义与纯展开（R6-1，`docs/r6-plan.md` §3 R6-1；方案 §7.2）。
 * 多数业务后端统一返回 `{ code, msg, data }` 一类包装，拦截器按成功码分支：
 * 场景声明一次 envelope 模板，fixture 只写 data，Runner 物化 Mock 时展开为完整响应体。
 *
 * 放在 shared 的原因与 FIXTURE_PLACEHOLDER 相同：shared/config/schema.ts 的 validateConfig
 * 需要 validateEnvelope 判定 config_invalid，shared 不得 import scenario（src/scenario/envelope.ts
 * 仅从本模块再导出，保持计划中的引用路径可用）。
 *
 * 约束：
 * - 纯数据变换，不执行项目代码；不属于执行项，不进执行指纹审批（与 http fixtures 同级）。
 * - 模板中必须恰好出现一次字符串值等于 ENVELOPE_DATA_TOKEN 的位置（对象键不替换）；零次或多次为 config_invalid。
 * - 只展开 JSON 响应体：bodyFile、204/205/304、fixture 显式 `envelope: false` 的条目原样保留。
 * - 展开后的响应体仍受占位标记校验：data 里残留 FIXTURE_PLACEHOLDER 照样拒绝。
 * - 未命中请求仍是 unmatched_request；envelope 不得被用来给未命中请求合成成功响应（硬约束 5）。
 */

import type { HttpFixture } from './config/schema.ts'
import { containsPlaceholder } from './fixture-draft.ts'

/** 模板中代表 fixture data 的位置标记；与 FIXTURE_PLACEHOLDER 区分，二者不可互换。 */
export const ENVELOPE_DATA_TOKEN = '__DSH_PREVIEW_DATA__'

/** 场景 envelope 声明（R6-1；同步 shared/config/schema.ts、JSON schema 与方案 §8）。 */
export interface EnvelopeConfig {
  /** JSON 模板，恰好一处字符串值等于 ENVELOPE_DATA_TOKEN，例如 `{ code: 0, msg: 'ok', data: TOKEN }`。 */
  template: unknown
}

/** 模板深度上限：业务包装模板不需要超过 8 层嵌套。 */
const ENVELOPE_MAX_DEPTH = 8
/** 模板序列化字节上限：防止把大对象塞进场景级模板。 */
const ENVELOPE_MAX_BYTES = 16 * 1024

/**
 * 校验模板：恰好一处 ENVELOPE_DATA_TOKEN、可 JSON 序列化、深度与大小有界。
 * 返回问题描述数组（空数组即通过），供 validateConfig 的 issue 与 write_scenario 的拒绝信息使用。
 */
export function validateEnvelope(envelope: EnvelopeConfig): string[] {
  const problems: string[] = []
  let tokens = 0
  const stack: unknown[] = []
  const visit = (value: unknown, depth: number): void => {
    if (problems.length >= 8) return
    if (typeof value === 'string') { if (value === ENVELOPE_DATA_TOKEN) tokens += 1; return }
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) problems.push('Envelope template numbers must be finite JSON numbers')
      return
    }
    const composite = Array.isArray(value) || typeof value === 'object'
    if (composite && value !== null) {
      if (depth > ENVELOPE_MAX_DEPTH) {
        problems.push('Envelope template nesting exceeds ' + ENVELOPE_MAX_DEPTH + ' levels')
        return
      }
      if (stack.includes(value)) {
        problems.push('Envelope template must be JSON-serializable (no circular references)')
        return
      }
      stack.push(value)
      for (const item of Array.isArray(value) ? value : Object.values(value)) visit(item, depth + 1)
      stack.pop()
      return
    }
    // undefined / function / symbol / bigint 均不是 JSON 值。
    const found = value === undefined ? 'undefined' : typeof value
    problems.push('Envelope template must contain only JSON values (found ' + found + ')')
  }
  visit(envelope?.template, 1)
  const count = tokens === 0 ? 'none' : String(tokens)
  if (tokens !== 1) {
    problems.push('Envelope template must contain the data token ' + ENVELOPE_DATA_TOKEN
      + ' exactly once (found ' + count + ')')
  }
  if (problems.length === 0) {
    try {
      const size = JSON.stringify(envelope.template).length
      if (size > ENVELOPE_MAX_BYTES) problems.push('Envelope template exceeds ' + ENVELOPE_MAX_BYTES + ' bytes')
    } catch { problems.push('Envelope template must be JSON-serializable') }
  }
  return problems
}

/**
 * 把一条 fixture 的 response.body 当作 data 套进模板，返回新的 fixture（不修改入参）。
 * 不展开的情形见文件头；展开结果用于 Mock 中间件，原配置文本不改写。
 * 模板缺标记/多标记或展开后仍含 FIXTURE_PLACEHOLDER 时抛错——调用方统一按 config_invalid 报告。
 */
export function applyEnvelope(fixture: HttpFixture, envelope: EnvelopeConfig): HttpFixture {
  const response = fixture.response
  if (fixture.envelope === false || response.bodyFile !== undefined
    || [204, 205, 304].includes(response.status) || response.body === undefined) return fixture
  let used = 0
  const expand = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value === ENVELOPE_DATA_TOKEN) { used += 1; return response.body }
      return value
    }
    if (Array.isArray(value)) return value.map(expand)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]))
    }
    return value
  }
  const body = expand(envelope.template)
  if (used !== 1) throw new Error('Scenario envelope template must use ' + ENVELOPE_DATA_TOKEN + ' exactly once')
  if (containsPlaceholder(body)) {
    throw new Error('Envelope-expanded fixture response still contains the fixture-draft placeholder')
  }
  return { ...fixture, response: { ...response, body } }
}
