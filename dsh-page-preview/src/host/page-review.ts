/** DSH 原生 /page-review 命令与读目标流程（方案 §4、§5）；执行仍走统一的 open 与审批。 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { buildModuleGraph } from '../adapters/vue/impact/module-graph.ts'
import { readRouteMap } from '../adapters/vue/impact/route-map.ts'
import { buildModuleGraph as buildReactModuleGraph } from '../adapters/react/impact/module-graph.ts'
import { readRouteMap as readReactRouteMap } from '../adapters/react/impact/route-map.ts'
import { loadWorkspaceProjects } from '../shared/config/projects.ts'
import { resolveProjectPath } from '../shared/config/paths.ts'
import type { OpenResult, TargetSelector } from '../shared/contracts.ts'
import { readProjectText } from '../shared/profile.ts'
import { scanProjectFiles } from '../shared/project-files.ts'
import { resolvePreviewCaller } from './caller.ts'
import type { OpenArgs, SessionRegistry } from './session-registry.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-page-review-command': { kind: 'dsh-page-review-command' }
  }
}

const USAGE = '/page-review <目标 ID、文件路径、页面路由或页面标题> [--scenario 场景ID] [--verify]'
  + '（可用 项目ID:目标）'
const ROUTE_CACHE_TTL_MS = 5_000
const ROUTE_CACHE_MAX = 16
interface CachedRoute {
  path: string
  component: string
  title?: string
}
interface RouteCacheEntry {
  expiresAt: number
  routerMtimeMs?: number
  routerModule?: string
  routes: CachedRoute[]
}
const routeMapCache = new Map<string, RouteCacheEntry>()

async function cachedRouteMap(framework: 'vue' | 'react', appRoot: string, entry?: string): Promise<CachedRoute[]> {
  const key = `${framework}\0${appRoot}\0${entry ?? ''}`
  const now = Date.now()
  const hit = routeMapCache.get(key)
  if (hit && hit.expiresAt > now) {
    let fresh = true
    if (hit.routerModule !== undefined) {
      const mtime = await stat(join(appRoot, hit.routerModule)).then(info => info.mtimeMs, () => undefined)
      if (mtime !== hit.routerMtimeMs) fresh = false
    }
    if (fresh) {
      routeMapCache.delete(key)
      routeMapCache.set(key, hit)
      return hit.routes
    }
    routeMapCache.delete(key)
  }
  const map = framework === 'vue'
    ? await readRouteMap(appRoot, entry, await buildModuleGraph(appRoot), { searchByTitle: true })
    : await readReactRouteMap(appRoot, entry, await buildReactModuleGraph(appRoot))
  const routerMtimeMs = map.routerModule === undefined ? undefined
    : await stat(join(appRoot, map.routerModule)).then(info => info.mtimeMs, () => undefined)
  const stored: RouteCacheEntry = {
    expiresAt: now + ROUTE_CACHE_TTL_MS,
    ...(map.routerModule === undefined ? {} : { routerModule: map.routerModule }),
    ...(routerMtimeMs === undefined ? {} : { routerMtimeMs }),
    routes: map.routes.map(route => ({
      path: route.path, component: route.component,
      ...('title' in route && typeof route.title === 'string' ? { title: route.title } : {}),
    })),
  }
  routeMapCache.set(key, stored)
  while (routeMapCache.size > ROUTE_CACHE_MAX) {
    routeMapCache.delete(routeMapCache.keys().next().value!)
  }
  return stored.routes
}

type CommandTarget = Pick<OpenArgs, 'projectId' | 'scenario' | 'waitFor'> & { target: TargetSelector }

function parseReviewInput(input: string): {
  selection: string
  scenario?: string
  verify: boolean
} | string {
  const tokens = input.split(/\s+/)
  let verify = false
  let scenario: string | undefined
  const rest: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '--verify') {
      verify = true
      continue
    }
    if (token === '--scenario') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) return '缺少 --scenario 的场景 ID。\n' + USAGE
      scenario = value
      i += 1
      continue
    }
    if (token.startsWith('--scenario=')) {
      const value = token.slice('--scenario='.length)
      if (!value) return '缺少 --scenario 的场景 ID。\n' + USAGE
      scenario = value
      continue
    }
    rest.push(token)
  }
  const selection = rest.join(' ').trim()
  if (!selection) return USAGE
  return { selection, ...(scenario === undefined ? {} : { scenario }), verify }
}

/** 动态菜单未在本地声明路由标题时，使用页面文件顶部注释中的首行标题。 */
async function matchViewHeadings(appRoot: string, files: readonly string[], titles: string[]): Promise<string[]> {
  const normalize = (value: string) => value.replace(/\s/g, '')
  const requested = new Set(titles.map(normalize).filter(Boolean))
  const matches: string[] = []
  for (const file of files) {
    if (!/^(?:src\/)?(?:pages|views)\/.+\.vue$/i.test(file) || file.split('/').includes('components')) continue
    const source = await readProjectText(join(appRoot, file), appRoot)
    const header = /^\s*<!--([\s\S]*?)-->/.exec(source ?? '')?.[1]
    const heading = header?.split(/\r?\n/).map(line => line.trim().replace(/^\*\s*/, '')).find(Boolean)
    if (heading !== undefined && requested.has(normalize(heading))) matches.push(file)
  }
  return matches
}

export async function resolvePageReviewTarget(raw: string, root: string, dataDir?: string)
  : Promise<CommandTarget | string> {
  const input = raw.trim()
  if (!input || input.length > 1024 || /[\r\n\0]/.test(input)) return USAGE
  const parsed = parseReviewInput(input)
  if (typeof parsed === 'string') return parsed
  const { selection, scenario, verify } = parsed
  const commandOptions = {
    ...(scenario === undefined ? {} : { scenario }),
    ...(verify ? { waitFor: 'assertions' as const } : {}),
  }
  const qualifier = /^([\w.-]+):\s*(.+)$/.exec(selection)
  const projectId = qualifier?.[1]
  const text = qualifier?.[2]?.trim() ?? selection
  const qualified = projectId === undefined ? {} : { projectId }
  if (/\.(?:vue|[cm]?[jt]sx?|html?)$/i.test(text) && !text.startsWith('/')) {
    return { ...qualified, ...commandOptions, target: { kind: 'file', path: text } }
  }

  const projects = (await loadWorkspaceProjects(root, undefined, dataDir === undefined ? {} : { dataDir }))
    .filter(({ config }) => projectId === undefined || config.project.id === projectId)
  const registered = projects.filter(({ config }) => config.project.targets?.some(target => target.id === text))
  if (registered.length === 1) {
    return { ...commandOptions, projectId: registered[0]!.config.project.id, target: { kind: 'registered', id: text } }
  }
  if (registered.length > 1) {
    return '多个应用注册了这个目标。指定其中一个项目 ID ' + registered.map(p => p.config.project.id).join('、')
  }

  const title = text.replace(/^预览\s*/, '').replace(/\s*(?:界面|页面)$/, '').trim()
  const routePath = text.startsWith('/')
  const matches = new Map<string, CommandTarget>()
  const addMatch = (id: string, file: string) => matches.set(`${id}:${file}`, {
    ...commandOptions, projectId: id, target: { kind: 'file', path: file },
  })
  const vueApps: Array<{ projectId: string; root: string }> = []
  for (const { config, profile } of projects) {
    const hasVue = profile.frameworks.some(({ value }) => value.name === 'vue')
    const hasReact = profile.frameworks.some(({ value }) => value.name === 'react')
    if (!hasVue && !hasReact) continue
    const appRoot = await resolveProjectPath(root, config.project.root)
    if (hasVue) {
      vueApps.push({ projectId: config.project.id, root: appRoot })
      for (const route of await cachedRouteMap('vue', appRoot, config.project.runtime.entry)) {
        if (routePath ? route.path === text : route.title === text || route.title === title) {
          addMatch(config.project.id, route.component)
        }
      }
    }
    if (hasReact && routePath) {
      for (const route of await cachedRouteMap('react', appRoot, config.project.runtime.entry)) {
        if (route.path === text) addMatch(config.project.id, route.component)
      }
    }
  }
  if (!routePath && matches.size === 0) {
    for (const app of vueApps) {
      const scan = await scanProjectFiles(app.root, 5000)
      const relFiles = scan.files.map(file => relative(app.root, file).split(sep).join('/'))
      for (const file of await matchViewHeadings(app.root, relFiles, [text, title])) addMatch(app.projectId, file)
    }
  }
  if (matches.size === 1) return matches.values().next().value!
  if (matches.size > 1) return '匹配到多个页面，请用文件路径指定目标。' + [...matches.keys()].slice(0, 5).join('、')
  return '找不到可静态定位的预览目标。请使用项目中注册的目标 ID 或实际文件路径。\n' + USAGE
}

async function runReview(registry: Pick<SessionRegistry, 'open'>, dataDir: string | undefined,
  invocation: CommandInvocation,
  turnSignal: AbortSignal, queuedAt: number): Promise<CommandResult> {
  const signal = AbortSignal.any([invocation.signal, turnSignal])
  signal.throwIfAborted()
  const resolveStarted = performance.now()
  const queueMs = Math.round(resolveStarted - queuedAt)
  const { workspaceRoot } = await resolvePreviewCaller(invocation.agent.session)
  const args: OpenArgs | string = await resolvePageReviewTarget(invocation.rawInput, workspaceRoot, dataDir)
  if (typeof args === 'string') return { kind: 'error', text: args }
  const resolveMs = Math.round(performance.now() - resolveStarted)
  const request = { ...args, waitFor: args.waitFor ?? 'mount' as const }
  const callId = ToolCallId(invocation.commandId)
  const exec: ToolRunContext = {
    agent: invocation.agent, callId, rootCallId: callId, name: '/page-review', arguments: request, signal,
    token: Symbol('page-review') as ToolExecutionToken, deferContext() {}, concludeTurn() {},
  }
  const result = await registry.open(request, exec)
  const preview = result.preview
  const shown = result.diagnostics.some(value => value.code === 'preview_shown_in_sidebar')
  const mount = preview?.readiness.targetMounted
  let shownText = preview?.strategy === 'isolated' ? '侧边栏已加载，页面挂载待确认。' : '预览已在侧边栏打开。'
  if (mount?.mountSignal === 'failed') shownText = '侧边栏已加载，页面挂载失败。'
  else if (mount?.mountSignal === 'observed' || mount?.status === 'proven') shownText = '页面已在侧边栏挂载。'
  const errors = result.diagnostics.filter(value => value.code !== 'preview_shown_in_sidebar'
    && value.code !== 'page_text_pending')
  const formatDiagnostic = (value: OpenResult['diagnostics'][number]) =>
    value.hint ? `${value.message}（建议：${value.hint}）` : value.message
  const draftLines: string[] = []
  if (result.setupDraft?.path) draftLines.push(`Setup 草稿：${result.setupDraft.path}`)
  if (result.setupDraft?.configSnippet) {
    const snippet = result.setupDraft.configSnippet
    const bounded = snippet.length > 600 ? snippet.slice(0, 600) + '\n...(truncated)' : snippet
    draftLines.push(`配置片段：\n${bounded}`)
  }
  const details = [...errors.map(formatDiagnostic), ...draftLines,
    ...commandDetails(result, queueMs, resolveMs, request.waitFor === 'assertions')]
  if (result.status !== 'ok') return {
    kind: 'error', text: [...(shown ? [shownText] : []), ...details].join('\n') || `预览未打开（${result.status}）`,
  }
  const text = [shown ? shownText : preview?.url ? `预览地址 ${preview.url}` : '预览正在启动，可在侧边栏查看进度。',
    ...details].join('\n')
  return { kind: 'success', text }
}

function commandDetails(result: OpenResult, queueMs: number, resolveMs: number, verify: boolean): string[] {
  const lines: string[] = []
  const { preview, timing, availableScenarios } = result
  if (preview) lines.push(`Mock 场景 ${preview.scenario ?? '未选择'}`)
  if (!preview?.scenario && availableScenarios?.length) {
    lines.push(`可用 --scenario 选择（最多列出 10 个）${availableScenarios.join('、')}`)
  }
  switch (preview?.verification) {
    case 'pending': lines.push('页面断言验证中，结果将在侧边栏更新。'); break
    case 'passed': lines.push('页面断言已通过。'); break
    case 'failed': lines.push('页面断言验证失败。'); break
    default: if (verify && preview) lines.push('当前目标未配置页面断言。')
  }
  if (timing) {
    const stages = [
      ['排队', queueMs], ['定位目标', resolveMs], ['预检', timing.preflightMs], ['审批', timing.approvalMs],
      ['请求 Runner', timing.runnerRequestMs], ['等待反馈', timing.readinessWaitMs],
    ] as const
    const measured = stages.flatMap(([label, ms]) => ms === undefined ? [] : [`${label} ${ms} ms`])
    lines.push(`耗时 ${queueMs + resolveMs + timing.totalMs} ms（${measured.join('、')}）`)
  }
  if (preview?.startupTiming) {
    const { serviceReadyMs, documentLoadedMs, mountFeedbackMs, assertionSettledMs } = preview.startupTiming
    const stages = [
      ['服务可达', serviceReadyMs], ['文档加载', documentLoadedMs],
      ['挂载反馈', mountFeedbackMs], ['断言结束', assertionSettledMs],
    ] as const
    const measured = stages.flatMap(([label, ms]) => ms === undefined ? [] : [`${label} ${ms} ms`])
    if (measured.length) lines.push(`自 Runner 启动起 ${measured.join('、')}`)
  }
  return lines
}

export function registerPageReviewCommand(ctx: Context, registry: Pick<SessionRegistry, 'open'>,
  dataDir?: string): void {
  const pending = new Map<string, {
    agent: CommandInvocation['agent']; run: (signal: AbortSignal) => Promise<void>
  }>()
  const isCommandMessage = (message: UserMessage) => message.source.kind === 'dsh-page-review-command'

  // 官方审批必须在活动轮次内。用 Agent 自己的调度入口，仅消费本命令的消息，保留其他输入。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (!messages.some(isCommandMessage)) return next()
    for (const message of messages.filter(isCommandMessage)) {
      const command = pending.get(message.id)
      if (command?.agent === agent) await command.run(signal)
    }
    if (messages.every(isCommandMessage)) return { kind: 'enter', messages: [] }
    const decision = await next()
    return decision.kind === 'enter' ? { ...decision, messages: decision.messages.filter(m => !isCommandMessage(m)) }
      : decision
  })

  ctx.commands.register({
    name: 'page-review', description: 'Open a project page preview directly',
    input: { hint: '目标 ID、文件路径、页面路由或页面标题' },
    handler(invocation) {
      if (!invocation.rawInput.trim()) return { kind: 'error', text: USAGE }
      const abortError = () => invocation.signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (invocation.signal.aborted) return Promise.reject(abortError())
      const { agent } = invocation
      const message = createUserMessage({ source: { kind: 'dsh-page-review-command' }, content: [] })
      const queuedAt = performance.now()
      return new Promise<CommandResult>((resolve, reject) => {
        const cleanup = () => invocation.signal.removeEventListener('abort', onAbort)
        const onAbort = () => {
          if (pending.delete(message.id)) reject(abortError())
        }
        invocation.signal.addEventListener('abort', onAbort, { once: true })
        pending.set(message.id, { agent, async run(signal) {
          pending.delete(message.id)
          cleanup()
          try { resolve(await runReview(registry, dataDir, invocation, signal, queuedAt)) }
          catch (error) { reject(error) }
        } })
        try { agent.followup(message) }
        catch (error) { cleanup(); pending.delete(message.id); reject(error); return }
        void agent.whenIdle().then(() => {
          cleanup()
          if (pending.delete(message.id)) resolve({ kind: 'error', text: '没有进入预览轮次，请在会话空闲时重试。' })
        }, error => { cleanup(); pending.delete(message.id); reject(error) })
      })
    },
  })
}
