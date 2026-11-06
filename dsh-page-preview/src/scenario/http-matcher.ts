/**
 * 声明式 HTTP fixture 匹配（方案 §7.2）。
 * - 匹配 origin、method、path，及声明了的 query / body
 * - 未声明 origin 时只匹配预览来源；跨域 API 需显式声明
 * - 同一请求命中多个声明式 fixture → 报告歧义，不取第一个
 * - 复用项目已有 MSW 时保留其匹配语义，不经过这里
 */

import type { HttpFixture } from '../shared/config/schema.ts'
import { isDeepStrictEqual } from 'node:util'

export interface HttpRequestInfo {
  origin: string
  method: string
  path: string
  query: Record<string, string>
  body?: unknown
}

export type MatchOutcome =
  | { kind: 'matched'; fixture: HttpFixture; index: number; params: Record<string, string> }
  | { kind: 'unmatched' }
  | { kind: 'ambiguous'; indexes: number[] }

/** 完整路径匹配；:name 只捕获一个编码后的路径段，返回解码一次的值，不把它解释成文件路径。 */
export function matchHttpPath(pattern: string, path: string): Record<string, string> | undefined {
  if (!pattern.startsWith('/') || pattern.startsWith('//') || /[?#]/.test(pattern)) throw new Error('HTTP fixture path must be an absolute pathname without query or hash')
  const names = new Set<string>()
  const segments = pattern.split('/').map(segment => {
    if (segment.startsWith(':')) {
      if (!/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || names.has(segment.slice(1))) throw new Error('HTTP fixture path has an invalid or repeated parameter name')
      names.add(segment.slice(1))
      return { name: segment.slice(1) }
    }
    try { return { literal: decodeURIComponent(segment) } }
    catch { throw new Error('HTTP fixture path has invalid percent encoding') }
  })
  const values = path.split('/')
  if (segments.length !== values.length) return undefined
  const params: Array<[string, string]> = []
  for (const [index, segment] of segments.entries()) {
    let value: string
    try { value = decodeURIComponent(values[index]!) } catch { return undefined }
    if (segment.name !== undefined) {
      if (!value) return undefined
      params.push([segment.name, value])
    } else if (segment.literal !== value) return undefined
  }
  return Object.fromEntries(params)
}

export function matchFixture(request: HttpRequestInfo, fixtures: readonly HttpFixture[], previewOrigin: string): MatchOutcome {
  const hits: Array<{ index: number; params: Record<string, string> }> = []
  fixtures.forEach((fixture, index) => {
    if ((fixture.origin ?? previewOrigin) !== request.origin) return
    if (fixture.method.toUpperCase() !== request.method.toUpperCase()) return
    const params = matchHttpPath(fixture.path, request.path)
    if (!params) return
    if (fixture.query && !Object.entries(fixture.query).every(([key, value]) => request.query[key] === value)) return
    if (fixture.body !== undefined && !isDeepStrictEqual(fixture.body, request.body)) return
    hits.push({ index, params })
  })
  if (hits.length === 0) return { kind: 'unmatched' }
  if (hits.length > 1) return { kind: 'ambiguous', indexes: hits.map(value => value.index) }
  const { index, params } = hits[0]!
  return { kind: 'matched', fixture: fixtures[index]!, index, params }
}
