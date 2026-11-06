/**
 * 项目配置协议的 TS 类型（方案 §8）。JSON Schema 见 schema/page-preview.config.schema.json，两者必须同步。
 * 这是插件自定的协议，不是 DSH 官方格式。
 */

import type { Requirement, Scope, Strategy, TargetSelector } from '../contracts.ts'
import { containsPlaceholder } from '../fixture-draft.ts'
import { validateEnvelope } from '../envelope.ts'
import type { EnvelopeConfig } from '../envelope.ts'
import { z } from 'zod'

export const SUPPORTED_SCHEMA_VERSION = 1

export interface PreviewConfigFile {
  $schema?: string
  schemaVersion: number
  projects: ProjectConfig[]
}

export interface ProjectConfig {
  id: string
  /** 相对工作区。 */
  root: string
  runtime: RuntimeConfig
  targets?: TargetConfig[]
  scenarios?: Record<string, ScenarioConfig>
}

export interface RuntimeConfig {
  strategy?: Strategy
  /** 已注册的适配器 ID，不是 npm 包名。 */
  adapter?: string
  requirements?: Requirement[]
  /** 以下路径均相对应用根。 */
  setup?: string
  styles?: string[]
  /** 入口注册重放的入口文件（§6.9）；省略时由适配器从构建配置推断。 */
  entry?: string
  /** static */
  publicRoot?: string
  spaFallback?: boolean
  /** project */
  command?: { executable: string; args: string[]; cwd: string }
  env?: Record<string, string>
  /** project / attach */
  origin?: string
  readiness?: { probePath?: string; serviceDeadlineMs?: number; targetDeadlineMs?: number }
  /** 显式批准的依赖根（workspace 共享包、符号链接）。 */
  dependencyRoots?: string[]
}

export interface TargetConfig {
  id: string
  /** 配置中不得使用 registered 自引用。 */
  selector: Exclude<TargetSelector, { kind: 'registered' }>
  scope?: Scope
  route?: { path: string; params?: Record<string, string>; query?: Record<string, string> }
  defaultScenario?: string
  assertions?: Array<{ kind: 'selector-visible'; selector: string } | { kind: 'text-present'; text: string }>
}

export interface HttpFixture {
  /** 省略时只匹配预览来源（§7.2）。 */
  origin?: string
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
  response: { status: number; headers?: Record<string, string>; body?: unknown; bodyFile?: string }
  /** AI 补全/人工编写的数据来源说明（§7.2）；草稿生成时预填模板，填写响应体时改写为真实来源。 */
  provenance?: string
  /** R6-1：逐条退出场景 envelope 展开（只能写 false）。 */
  envelope?: false
}

export interface ScenarioConfig {
  identity?: Record<string, unknown>
  permissions?: string[]
  state?: Record<string, unknown>
  props?: Record<string, unknown>
  route?: { path: string; params?: Record<string, string>; query?: Record<string, string> }
  locale?: string
  /** 自有 HTTP Mock 的显式业务路径范围，不从接口名或同源推断。 */
  businessPaths?: string[]
  http?: HttpFixture[]
  /** 项目 handler 模块（§7.2 写交互）。 */
  handlers?: string
  /**
   * R5-1g：声明式 WebSocket 通道（固定消息序列，同源受控）。
   * 声明路径本身的 Upgrade 即准入，不要求 businessPaths；未声明路径的 Upgrade 仍 block。
   */
  ws?: WsFixture[]
  /** R5-1g：声明式 SSE 通道；GET 命中声明路径即经场景层供出事件流，未声明仍 unmatched。 */
  sse?: SseFixture[]
  /**
   * R6-1：场景级响应包装模板——fixture 只写 data，物化时展开为完整包装体。
   * 纯数据变换，不执行项目代码；结构由 shared/envelope.ts 定义与校验。
   */
  envelope?: EnvelopeConfig
}

/** R5-1g：一条声明式 WS 通道——连接建立后按序发送固定消息，可选按收到内容应答。 */
export interface WsFixture {
  /** 同源 pathname（不带 query/hash）。 */
  path: string
  /** 连接建立后按序发送；delay 毫秒（0–60000）。 */
  send?: Array<{ data: string; delay?: number }>
  /** 收到客户端文本帧时的固定应答（精确匹配）。 */
  replies?: Array<{ match: string; data: string }>
  /** 播完 send 后的关闭码与原因；省略则保持连接。 */
  close?: { code?: number; reason?: string }
}

/** R5-1g：一条声明式 SSE 通道——GET 命中后按序写事件流。 */
export interface SseFixture {
  /** 同源 pathname（不带 query/hash）。 */
  path: string
  events: Array<{ data: string; event?: string; id?: string; retry?: number; delay?: number }>
  /** 播完后保持连接（默认播完即结束流）。 */
  keepOpen?: boolean
}

export interface ConfigIssue {
  path: string
  message: string
}

const relPath = z.string().min(1).regex(/^(?![\\/]|[A-Za-z]:)/, 'Expected a relative path')
export const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)
const id = projectIdSchema
const stringMap = z.record(z.string(), z.string())
const route = z.strictObject({ path: z.string(), params: stringMap.exactOptional(), query: stringMap.exactOptional() })
const selector = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: relPath, exportName: z.string().exactOptional() }),
  z.strictObject({ kind: z.literal('route'), ...route.shape, layout: z.boolean().exactOptional() }),
  z.strictObject({ kind: z.literal('story'), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal('url'), url: z.string().min(1) }),
])
const assertion = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selector-visible'), selector: z.string().min(1) }),
  z.strictObject({ kind: z.literal('text-present'), text: z.string().min(1) }),
])
const fixture = z.strictObject({
  origin: z.string().exactOptional(), method: z.string().min(1), path: z.string(),
  query: stringMap.exactOptional(), body: z.unknown().exactOptional(),
  response: z.strictObject({ status: z.int().min(100).max(599), headers: stringMap.exactOptional(), body: z.unknown().exactOptional(), bodyFile: relPath.exactOptional() }),
  provenance: z.string().exactOptional(),
  envelope: z.literal(false).exactOptional(),
})
const channelPath = z.string().min(1).regex(/^\/[^?#]*$/, 'Expected a same-origin pathname without query or hash')
const delayMs = z.int().min(0).max(60000)
const wsFixture = z.strictObject({
  path: channelPath,
  send: z.array(z.strictObject({ data: z.string(), delay: delayMs.exactOptional() })).exactOptional(),
  replies: z.array(z.strictObject({ match: z.string(), data: z.string() })).exactOptional(),
  close: z.strictObject({ code: z.int().min(1000).max(4999).exactOptional(),
    reason: z.string().exactOptional() }).exactOptional(),
})
const sseFixture = z.strictObject({
  path: channelPath,
  events: z.array(z.strictObject({
    data: z.string(), event: z.string().exactOptional(), id: z.string().exactOptional(),
    retry: z.int().min(0).exactOptional(), delay: delayMs.exactOptional(),
  })).min(1),
  keepOpen: z.boolean().exactOptional(),
})
// R6-1：场景级 envelope 模板 + fixture `envelope:false` 逐条退出；语义校验（标记恰一处、
// JSON 值、深度/大小有界）在 validateConfig 中经 shared/envelope.ts 判定，不放宽字段。
/** 场景配置的严格结构；worker 的场景更新消息复用同一校验，不放宽字段。 */
export const scenarioConfigSchema = z.strictObject({
  identity: z.record(z.string(), z.unknown()).exactOptional(), permissions: z.array(z.string()).exactOptional(),
  state: z.record(z.string(), z.unknown()).exactOptional(), props: z.record(z.string(), z.unknown()).exactOptional(),
  route: route.exactOptional(), locale: z.string().exactOptional(), businessPaths: z.array(z.string().min(1)).exactOptional(), http: z.array(fixture).exactOptional(), handlers: relPath.exactOptional(),
  ws: z.array(wsFixture).exactOptional(), sse: z.array(sseFixture).exactOptional(),
  envelope: z.strictObject({ template: z.unknown() }).exactOptional(),
})
const runtime = z.strictObject({
  strategy: z.enum(['static', 'isolated', 'project', 'attach']).exactOptional(),
  adapter: z.enum(['static', 'project-command', 'existing-server', 'vue-vite', 'vue-cli', 'react-vite'])
    .exactOptional(),
  requirements: z.array(z.enum(['isolated-target', 'mock-only'])).exactOptional(),
  setup: relPath.exactOptional(), styles: z.array(relPath).exactOptional(), entry: relPath.exactOptional(),
  publicRoot: relPath.exactOptional(), spaFallback: z.boolean().exactOptional(),
  command: z.strictObject({ executable: z.string().min(1), args: z.array(z.string()), cwd: relPath }).exactOptional(),
  env: stringMap.exactOptional(),
  origin: z.string().regex(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/).exactOptional(),
  readiness: z.strictObject({ probePath: z.string().regex(/^\/(?!\/)/).exactOptional(), serviceDeadlineMs: z.int().positive().exactOptional(), targetDeadlineMs: z.int().positive().exactOptional() }).exactOptional(),
  dependencyRoots: z.array(z.string().min(1)).exactOptional(),
})
const projectSchema = z.strictObject({
  id, root: relPath, runtime,
  targets: z.array(z.strictObject({ id, selector, scope: z.enum(['page', 'component', 'shell']).exactOptional(), route: route.exactOptional(), defaultScenario: z.string().exactOptional(), assertions: z.array(assertion).exactOptional() })).exactOptional(),
  scenarios: z.record(z.string(), scenarioConfigSchema).exactOptional(),
})

/** JSON Schema 由此结构生成；跨项目 ID/场景引用等语义由 validateConfig 进一步检查。 */
export const configFileSchema = z.strictObject({ $schema: z.string().exactOptional(), schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION), projects: z.array(projectSchema) })

/**
 * 严格校验：未知字段、重复 ID、缺失场景、strategy/adapter 不一致、未知 schemaVersion 均报错，不忽略。
 * 只报告字段路径和约束，不回显配置值；校验不代表已批准执行其中的命令或模块。
 */
export function validateConfig(raw: unknown): { config?: PreviewConfigFile; issues: ConfigIssue[] } {
  const parsed = configFileSchema.safeParse(raw)
  if (!parsed.success) return { issues: parsed.error.issues.map(issue => ({ path: pointer(issue.path), message: issue.message })) }
  const config: PreviewConfigFile = parsed.data
  const issues: ConfigIssue[] = []
  const projectIds = new Set<string>()
  const strategies: Record<string, Strategy> = {
    static: 'static', 'project-command': 'project', 'existing-server': 'attach',
    'vue-vite': 'isolated', 'vue-cli': 'isolated', 'react-vite': 'isolated',
  }
  const issue = (path: string, message: string) => issues.push({ path, message })
  for (const [index, project] of config.projects.entries()) {
    const path = '/projects/' + index
    if (projectIds.has(project.id)) issue(path + '/id', 'Duplicate project ID')
    projectIds.add(project.id)
    const targetIds = new Set<string>()
    for (const [targetIndex, target] of (project.targets ?? []).entries()) {
      const targetPath = path + '/targets/' + targetIndex
      if (targetIds.has(target.id)) issue(targetPath + '/id', 'Duplicate target ID')
      targetIds.add(target.id)
      if (target.defaultScenario !== undefined && !Object.hasOwn(project.scenarios ?? {}, target.defaultScenario)) issue(targetPath + '/defaultScenario', 'Referenced scenario does not exist')
      if (target.selector.kind === 'url') {
        try {
          const url = new URL(target.selector.url)
          if (!project.runtime.origin || url.origin !== new URL(project.runtime.origin).origin || url.username || url.password) issue(targetPath + '/selector/url', 'Target URL must use the configured local origin without credentials')
        } catch { issue(targetPath + '/selector/url', 'Invalid target URL') }
      }
    }
    const runtime = project.runtime
    const inferred = runtime.adapter === undefined ? undefined : strategies[runtime.adapter]
    if (runtime.strategy && inferred && runtime.strategy !== inferred) issue(path + '/runtime/adapter', 'Adapter and strategy do not match')
    const strategy = runtime.strategy ?? inferred
    if (runtime.requirements && new Set(runtime.requirements).size !== runtime.requirements.length) issue(path + '/runtime/requirements', 'Duplicate requirement')
    if (runtime.origin) { try { new URL(runtime.origin) } catch { issue(path + '/runtime/origin', 'Invalid local origin') } }
    if (strategy === 'attach') {
      if (!runtime.origin) issue(path + '/runtime/origin', 'Existing server requires an explicit local origin')
      if (runtime.command !== undefined) issue(path + '/runtime/command', 'Attach cannot start a command')
      if (runtime.env !== undefined) issue(path + '/runtime/env', 'Attach cannot change an existing process environment')
    }
    if (strategy === 'project') {
      if (!runtime.command) issue(path + '/runtime/command', 'Project strategy requires an explicit command')
      if (!runtime.readiness?.probePath || !runtime.readiness.serviceDeadlineMs) issue(path + '/runtime/readiness', 'Project strategy requires a service probe and startup deadline')
    }
    // R3-1（D1）：草稿响应体仍是占位标记时拒绝生效——未填写的草稿不得当作 mock 成功。
    for (const [scenarioName, scene] of Object.entries(project.scenarios ?? {})) {
      const scenePath = path + '/scenarios/' + escapePointer(scenarioName)
      // R6-1：envelope 模板必须恰好一处数据标记、JSON 值、有界；逐条问题如实报字段。
      if (scene.envelope !== undefined) {
        for (const problem of validateEnvelope(scene.envelope)) {
          issue(scenePath + '/envelope/template', problem)
        }
      }
      for (const [fixtureIndex, item] of (scene.http ?? []).entries()) {
        if (containsPlaceholder(item.response.body) || containsPlaceholder(item.response.headers)) {
          issue(scenePath + '/http/' + fixtureIndex + '/response',
            'Fixture response still contains the fixture-draft placeholder; fill in real response data before using it')
        }
      }
    }
  }
  return issues.length ? { issues } : { config, issues }
}

function pointer(path: PropertyKey[]): string { return '/' + path.map(key => String(key).replaceAll('~', '~0').replaceAll('/', '~1')).join('/') }
function escapePointer(key: string): string { return key.replaceAll('~', '~0').replaceAll('/', '~1') }

export function configJsonSchema() {
  return {
    ...z.toJSONSchema(configFileSchema),
    $id: 'https://dsh-page-preview.local/schema/page-preview.config.schema.json',
    title: 'dsh-page-preview project config',
    description: '由 src/shared/config/schema.ts 生成的结构校验；ID、场景引用、策略兼容及来源/路径约束另由运行时校验。'
      + '插件自定协议（方案 §8），不是 DSH 官方格式。',
  }
}
