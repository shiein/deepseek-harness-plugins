/**
 * fixture 草稿的共享类型与占位标记（方案 §7.2；R3 计划 R3-1，Aesc 默认决策 D1）。
 * FIXTURE_PLACEHOLDER 与 containsPlaceholder 放在 shared：shared/config/schema.ts 的
 * validateConfig 需要拒绝仍含占位标记的响应体，shared 不得 import scenario。
 */

import type { HttpFixture } from './config/schema.ts'

/** 草稿响应体占位标记；出现在生效配置中即为 config_invalid。 */
export const FIXTURE_PLACEHOLDER = '__DSH_PREVIEW_FILL_RESPONSE__'

/** draftFixtures 的输入条目（UnmatchedRequestEntry 的请求匹配部分）。 */
export interface UnmatchedForDraft {
  method: string
  origin?: string
  path: string
  queryKeys: readonly string[]
  count: number
}

/** 写方法未命中 → scenario.handlers 模块的条目模板（R5-1f，方案 §7.2 写交互）。 */
export interface HandlerDraft {
  method: string
  path: string
  /** 跨源写请求的原始 origin；同名条目放进 handler 的守卫条件。 */
  origin?: string
  /**
   * 可直接改造成 handlers default 数组条目的函数文本。
   * 模板注明：写操作不会反映到后续读取，除非 handler 读写 ScenarioStore。
   */
  template: string
}

/** R5-fix1：OpenAPI schema 取样得到的响应结构提示——值是示例而非真实数据，仅供 Agent 填写时参考。 */
export interface FixtureShapeHint {
  method: string
  path: string
  /** 跨源条目的原 origin（与对应 fixture 一致）。 */
  origin?: string
  /** schema 取样结构；值是示例，不得直接当作响应体。 */
  shape: unknown
  /** 提示来源（OpenAPI 文件与操作）。 */
  provenance: string
}

/**
 * R6-2：一个未命中条目的调用点上下文（只读收集，有界）。只进草稿，永远不作为响应体。
 * 字段定稿后同步方案 §4.2（status 输出）与 §7.2。
 */
export interface CallSiteContext {
  method: string
  path: string
  /**
   * 出现该路径字面量的请求函数位置（相对应用根）与片段。
   * match 标记字面量与未命中路径的确定性关系：exact 字面量相等；
   * template-prefix 静态模板前缀命中（前缀边界在 '/'）；suffix 前缀不一致兜底
   * （未命中路径以字面量结尾且边界恰在 '/'，如源码 `/user/info` ↔ 未命中 `/api/user/info`）。
   */
  requestSites: Array<{ file: string; line: number; snippet: string; match: 'exact' | 'template-prefix' | 'suffix' }>
  /** 调用请求函数的位置与对返回值读取的属性链（如 `res.data.menuList`）。 */
  consumers: Array<{ file: string; line: number; snippet: string; fields: string[] }>
  /** 仅当调用点显式写出响应类型时给出；值是示例，provenance 写明类型名与位置。 */
  typeHint?: { shape: unknown; provenance: string }
}

/**
 * R6-1b：从拦截器等处只读识别的响应包装线索；只是建议，不会自动写入场景 envelope。
 * 字段定稿后同步方案 §4.2 与 §7.2。
 */
export interface EnvelopeHint {
  /** 建议的 envelope 模板（含 ENVELOPE_DATA_TOKEN）。 */
  template: unknown
  /** 依据：文件、行号与片段（如 `if (res.data.code !== 0)`）。 */
  evidence: Array<{ file: string; line: number; snippet: string }>
}

export interface FixtureDraft {
  /** 草稿所属场景名（调用方传入；预览未选场景时建议名为 'default'）。 */
  scenario: string
  fixtures: HttpFixture[]
  /**
   * 只有 OpenAPI schema 可取样（无显式 example、无 mock 数据）时给出的结构提示（有界）：
   * 对应 fixture 的响应体仍是占位标记，必须填真实数据后才能通过校验和写回（R5-fix1）。
   */
  shapeHints?: FixtureShapeHint[]
  /** 建议的 businessPaths（按共同前缀归纳，如 '/api/**'），只是建议，Agent 需核对。 */
  businessPaths: string[]
  /** 可直接粘贴进 projects[].scenarios 的 JSON 片段（已格式化）。 */
  configSnippet: string
  /** 写方法（POST/PUT/PATCH/DELETE）未命中的 handler 模板；写请求仍各带一条静态 http fixture。 */
  handlerDrafts: HandlerDraft[]
  /** 按请求次数排序后被截断的条目数。 */
  omitted: number
  /**
   * 观察到的跨源未命中（有界）。R5-1c 起它们也会按原 origin 生成 fixture（经同源 remote
   * 通道匹配）；本字段保留观察报告，供 Agent 区分哪些条目来自跨源改写。
   */
  crossOrigin: Array<{ method: string; origin: string; path: string; count: number }>
  /**
   * R6-1d：从源码拦截器证据只读识别出的包装模板建议；场景已声明 envelope 时不给出。
   * 只是建议，不会被自动写入任何配置。
   */
  envelopeHint?: EnvelopeHint
  /**
   * R6-2：按未命中条目只读收集的调用点上下文（有界）。只进草稿，永远不作为响应体；
   * typeHint 与 shapeHints 同级，值是示例而非真实数据。
   */
  contexts?: CallSiteContext[]
  /** R6-2：调用点收集触顶（时间/条目数预算）时为 true；调用方据此产生可见诊断。 */
  contextLimited?: boolean
}

/**
 * 深度检查值中是否残留占位标记：字符串等于标记即命中；
 * 数组/普通对象递归检查，其他类型不命中。供 validateConfig 拒绝未填写的草稿。
 */
export function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value === FIXTURE_PLACEHOLDER
  if (Array.isArray(value)) return value.some(containsPlaceholder)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsPlaceholder)
  }
  return false
}
