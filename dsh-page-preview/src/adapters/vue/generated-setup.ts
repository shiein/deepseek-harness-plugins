/**
 * 插件自动生成并使用的 setup（方案 §0.3 第 10 条、§6.9）。项目未配置 runtime.setup 时，从应用入口重放全局
 * 注册（第三方与业务的 use/component/directive/全局属性、样式与副作用导入、顶层初始化调用链），业务路由在
 * 运行时换成空路由。预检只读生成并取摘要计入执行指纹；worker 启动前用同一函数重新生成并核对摘要，
 * 入口在批准后被改动则拒绝执行。生成源码只在 Runner 内作为模块加载，不写入目标项目，也不进工具输出。
 */
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { generateSetupDraft, parseEntryRegistrations } from './entry-replay.ts'
import type { EntryReplayResult } from './entry-replay.ts'
import type { VueMajor } from './detect.ts'

export interface GeneratedSetup {
  /** 入口相对应用根。 */
  entry: string
  source: string
  hash: string
  replay: EntryReplayResult
}

/**
 * importPath：绝对文件路径在生成模块中的导入写法（Vite 用裸绝对路径交其解析，webpack 原样）。
 * 无法重放（语法无效、Vue 主版本未知、入口找不到框架绑定或混用 2/3）时返回原因，由调用方走手写 setup 路径。
 */
export async function buildGeneratedSetup(
  appRoot: string, entry: string, major: VueMajor | 'unknown', importPath?: (file: string) => string,
): Promise<GeneratedSetup | { reason: string, replay?: EntryReplayResult }> {
  const replay = await parseEntryRegistrations(appRoot, entry)
  if (replay.invalid) return { reason: 'Entry syntax is invalid', replay }
  if (major === 'unknown') return { reason: 'Installed Vue major version is unknown', replay }
  const family = major === '3' ? '3' : '2'
  if (!replay.draft.frameworks.length || replay.draft.frameworks.some(value => value !== family)) {
    return { reason: 'The entry has no single replayable Vue ' + family + ' application', replay }
  }
  const source = generateSetupDraft(replay, major, importPath ? { importPath } : {})
  const hash = createHash('sha256').update(source).digest('hex')
  return { entry: relative(appRoot, replay.entryFile), source, hash, replay }
}

/** 计划 toolchain.vue 的实际版本 → 生成 setup 所用的 Vue 主版本标记。 */
function majorFromVersion(version: string | undefined): VueMajor | undefined {
  if (version?.startsWith('3.')) return '3'
  if (version?.startsWith('2.7.')) return '2.7'
  if (version?.startsWith('2.6.')) return '2.6'
  return undefined
}

/** worker 启动前：按计划记录的入口重新生成，并与批准时的摘要一致才可加载。 */
export async function verifiedGeneratedSetup(
  appRoot: string, planned: { entry: string, hash: string }, vueVersion: string | undefined,
  importPath?: (file: string) => string,
): Promise<string> {
  const major = majorFromVersion(vueVersion)
  if (major === undefined) throw new Error('Vue runtime version is unresolved for the generated setup')
  const built = await buildGeneratedSetup(appRoot, planned.entry, major, importPath)
  if ('reason' in built) throw new Error('The generated setup can no longer be built: ' + built.reason)
  if (built.hash !== planned.hash) {
    throw new Error('The application entry changed after the generated setup was approved; open the preview again')
  }
  return built.source
}

/** 计划 knownDifferences 用的人读摘要：只含数量、函数名、行号与模块说明符，不含原始表达式。 */
export function generatedSetupNotes(built: GeneratedSetup): string[] {
  const replayed = built.replay.registrations.filter(value => value.replay !== undefined).length
  const transplant = built.replay.draft.transplant
  const chain = [transplant?.name ?? '', ...(transplant?.chain ?? []).map(piece => piece.name)]
    .filter(value => value !== '').join('/') + '()'
  const invoked = !!transplant?.tail?.length
  return [
    'Initialization is replayed from ' + built.entry + ' through a plugin-generated setup (' + replayed
      + ' top-level registrations/imports' + (transplant ? ', initializer ' + chain : '')
      + '); the business router is replaced by an inert router and entry login/API calls run '
      + (invoked ? 'as the entry invokes them' : 'are not executed'),
    ...built.replay.diagnostics.map(value => 'Not replayed: ' + value),
  ]
}
