/**
 * 未命中请求响应草稿的项目数据来源（方案 §7.2 顺序；R5-1b）。全部只读、有界：
 *   1. 项目已有 fixture/Mock 数据：mock 目录下的 .json，按目录相对路径映射请求路径
 *   2. OpenAPI/Swagger 文档：paths[method][path] 首个 2xx JSON 响应的显式 example/examples
 * 只有"真实数据"可以替换占位标记；OpenAPI schema 取样得到的结构不是真实数据，
 * 只经 shapeHint 供 Agent 参考（R5-fix1：schema 取样值曾绕过占位保护，已移除；
 * "按 URL 猜 TS 类型名"一层精度低、属过度设计，一并移除）。
 * 不执行项目代码，不读取 .env*；扫描上限与 readProjectText 的范围核对沿用共享约束。
 */

import { realpath, stat } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readProjectText } from '../shared/profile.ts'
import { scanProjectFiles } from '../shared/project-files.ts'

/**
 * 一个条目的来源结论（判别联合，同一来源不会同时给出两类）：
 * - `body`：真实数据（mock JSON 原文 / OpenAPI 显式 example），可替换 FIXTURE_PLACEHOLDER
 * - `shapeHint`：schema 取样结构，值是示例而非真实数据；仅供 Agent 填写时参考，不进响应体
 */
export type FixtureSource =
  | { body: unknown; provenance: string }
  | { shapeHint: { shape: unknown; provenance: string } }

export interface DraftSourceEntry {
  method: string
  path: string
}

/** 各来源命中前的候选目录（相对应用根）；只在存在时扫描。 */
const MOCK_DIRECTORIES = ['mock', 'mocks', 'fixture', 'fixtures', '__mocks__', 'src/mock', 'src/mocks'] as const
const MOCK_FILE_LIMIT = 100
const MOCK_FILE_BYTES = 256 * 1024
const OPENAPI_NAME = /(?:openapi|swagger)/i
const OPENAPI_FILE_BYTES = 1024 * 1024
const OPENAPI_FILE_LIMIT = 4
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])

interface MockFile { path: string; method?: string; file: string; body: unknown }
interface OpenApiDoc { file: string; root: Record<string, unknown>; paths: Record<string, Record<string, unknown>> }

/**
 * 收集应用根下的 fixture 来源。resolve 按 §7.2 顺序查找响应体来源；
 * 任何单文件解析失败只跳过该文件，不使整个草稿失败。
 */
export async function collectFixtureSources(appRoot: string):
  Promise<{ resolve(entry: DraftSourceEntry): FixtureSource | undefined }> {
  // realpath：与 readProjectText 的 isWithinRoot 核对使用同一规范化根（缺失时 ENOENT 向上抛）。
  const root = await realpath(appRoot)
  if (!(await stat(root)).isDirectory()) throw new Error('Application root missing')
  const scan = await scanProjectFiles(root, 5000)
  const rel = (file: string) => relative(root, file).split(sep).join('/')
  const mocks: MockFile[] = []
  const openapi: OpenApiDoc[] = []

  for (const dir of MOCK_DIRECTORIES) {
    const prefix = dir + '/'
    for (const file of scan.files.filter(value => rel(value).startsWith(prefix) && value.endsWith('.json'))) {
      if (mocks.length >= MOCK_FILE_LIMIT) break
      const size = await stat(file).then(value => value.size).catch(() => Infinity)
      if (size > MOCK_FILE_BYTES) continue
      const text = await readProjectText(file, root).catch(() => undefined)
      if (text === undefined) continue
      let body: unknown
      try { body = JSON.parse(text) } catch { continue }
      const mapped = mockRequestPath(rel(file).slice(prefix.length))
      if (mapped === undefined) continue
      mocks.push({ ...mapped, file: rel(file), body })
    }
  }

  const isOpenApiFile = (file: string) =>
    OPENAPI_NAME.test(file.split(sep).pop() ?? '') && /\.(?:json|ya?ml)$/i.test(file)
  for (const file of scan.files.filter(isOpenApiFile)) {
    if (openapi.length >= OPENAPI_FILE_LIMIT) break
    const size = await stat(file).then(value => value.size).catch(() => Infinity)
    if (size > OPENAPI_FILE_BYTES) continue
    const text = await readProjectText(file, root).catch(() => undefined)
    if (text === undefined) continue
    let doc: unknown
    try { doc = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text) } catch { continue }
    const paths = isRecord(doc) && isRecord(doc.paths) ? doc.paths : undefined
    if (!paths || !Object.values(paths).some(isRecord)) continue
    openapi.push({ file: rel(file), root: doc as Record<string, unknown>, paths: paths as OpenApiDoc['paths'] })
  }

  const fromMock = (entry: DraftSourceEntry): FixtureSource | undefined => {
    const method = entry.method.toLowerCase()
    const exact = mocks.filter(value => value.path === entry.path && value.method === method)
    const generic = mocks.filter(value => value.path === entry.path && value.method === undefined)
    const hit = exact[0] ?? generic[0]
    return hit === undefined ? undefined
      : { body: hit.body, provenance: 'Copied from project mock data file ' + hit.file }
  }
  const fromOpenApi = (entry: DraftSourceEntry): FixtureSource | undefined => {
    for (const doc of openapi) {
      for (const [pattern, item] of Object.entries(doc.paths)) {
        if (pattern !== entry.path && !openApiPathMatch(pattern, entry.path)) continue
        const operation = isRecord(item) ? item[entry.method.toLowerCase()] : undefined
        if (!isRecord(operation)) continue
        const where = doc.file + ' (' + entry.method.toUpperCase() + ' ' + pattern + ')'
        const example = explicitExample(operation)
        if (example !== undefined) {
          return { body: example, provenance: 'Copied from the explicit example in OpenAPI ' + where }
        }
        const shape = schemaSample(operation, doc.root)
        if (shape !== undefined) {
          return { shapeHint: { shape, provenance: 'Example shape sampled from the OpenAPI schema in '
            + where + '; values are schema-derived examples, not real data' } }
        }
      }
    }
    return undefined
  }
  return { resolve: entry => fromMock(entry) ?? fromOpenApi(entry) }
}

/** mock/…/api/orders.get.json → { path:'/api/orders', method:'get' }；无方法后缀的文件匹配任意方法。 */
function mockRequestPath(stripped: string): { path: string; method?: string } | undefined {
  const parts = stripped.replace(/\.json$/i, '').split('/').filter(Boolean)
  if (!parts.length) return undefined
  let method: string | undefined
  const last = parts[parts.length - 1]!
  if (HTTP_METHODS.has(last.toLowerCase())) method = parts.pop()!.toLowerCase()
  else if (/\.(?:get|post|put|patch|delete|head|options)$/i.test(last)) {
    const index = last.lastIndexOf('.')
    method = last.slice(index + 1).toLowerCase()
    parts[parts.length - 1] = last.slice(0, index)
  }
  return parts.length ? { path: '/' + parts.join('/'), ...(method === undefined ? {} : { method }) } : undefined
}

/** OpenAPI 路径模板匹配：{name} 捕获一个非空段；其余段逐字相等。 */
function openApiPathMatch(pattern: string, path: string): boolean {
  const wanted = pattern.split('/')
  const actual = path.split('/')
  if (wanted.length !== actual.length) return false
  return wanted.every((segment, index) =>
    /^\{[^/{}]+\}$/.test(segment) ? actual[index]!.length > 0 : segment === actual[index])
}

/** 响应代码查找顺序：200→201→其他 2xx→default。 */
function responseItems(operation: Record<string, unknown>): Array<Record<string, unknown>> {
  const responses = isRecord(operation.responses) ? operation.responses : {}
  const rest = Object.keys(responses).filter(code => /^2\d\d$/.test(code) && !['200', '201'].includes(code))
  const codes = ['200', '201', ...rest, 'default']
  return codes.map(code => responses[code]).filter(isRecord)
}

/** JSON 媒体条目：application/json 优先，否则首个有结构的 content 条目。 */
function jsonMedia(response: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = isRecord(response.content) ? response.content : {}
  const media = isRecord(content['application/json']) ? content['application/json']
    : Object.values(content).find(isRecord)
  return isRecord(media) ? media : undefined
}

/**
 * 显式写出的 example（真实数据）：response.example → media.example →
 * media.examples 首个条目的 .value。除此之外一律不算真实数据。
 */
function explicitExample(operation: Record<string, unknown>): unknown {
  for (const response of responseItems(operation)) {
    if (response.example !== undefined) return response.example
    const media = jsonMedia(response)
    if (!isRecord(media)) continue
    if (media.example !== undefined) return media.example
    if (isRecord(media.examples)) {
      const first = Object.values(media.examples).find(isRecord)
      if (first?.value !== undefined) return first.value
    }
  }
  return undefined
}

/** schema 取样结构（仅供 shapeHint）：首个 2xx 响应中带 schema 的媒体条目。 */
function schemaSample(operation: Record<string, unknown>, root: Record<string, unknown>): unknown {
  for (const response of responseItems(operation)) {
    const media = jsonMedia(response)
    if (!isRecord(media) || !isRecord(media.schema)) continue
    const sampled = sampleSchema(media.schema, root, 0)
    if (sampled !== undefined) return sampled
  }
  return undefined
}

/** 有界 schema 取样：本地 $ref 解析 ≤4 层，example/default/enum 优先，数组取单元素样本。 */
function sampleSchema(schema: Record<string, unknown>, root: Record<string, unknown>, depth: number): unknown {
  if (depth > 4) return undefined
  const ref = typeof schema.$ref === 'string' ? schema.$ref : undefined
  if (ref !== undefined) {
    const resolved = resolveLocalRef(ref, root)
    return isRecord(resolved) ? sampleSchema(resolved, root, depth + 1) : undefined
  }
  if (schema.example !== undefined) return schema.example
  if (schema.default !== undefined) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type.find(value => value !== 'null') : schema.type
  if (type === 'string') return 'example'
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return false
  if (type === 'array' && isRecord(schema.items)) {
    const item = sampleSchema(schema.items, root, depth + 1)
    return item === undefined ? [] : [item]
  }
  if (type === 'object' || isRecord(schema.properties)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(isRecord(schema.properties) ? schema.properties : {})) {
      if (!isRecord(child)) continue
      const value = sampleSchema(child, root, depth + 1)
      if (value !== undefined) out[key] = value
    }
    return out
  }
  return undefined
}

/** 只解析 '#/…' 本地引用；外部引用不取。 */
function resolveLocalRef(ref: string, root: Record<string, unknown>): unknown {
  if (!ref.startsWith('#/')) return undefined
  let node: unknown = root
  for (const segment of ref.slice(2).split('/')) {
    if (!isRecord(node)) return undefined
    node = node[segment.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return node
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
