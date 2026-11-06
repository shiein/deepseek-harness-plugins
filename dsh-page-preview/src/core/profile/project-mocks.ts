/**
 * 项目已有 Mock 的只读识别（方案 §7.2"优先使用项目已有 Mock"；R3 计划 R3-3，Aesc 默认决策 D1）。
 *
 * 识别结果进入计划的 knownDifferences 与一条信息性诊断。R5-1e 起，Vite 策略对选项可静态求值的
 * vite-plugin-mock 在 Runner 中执行（temporaryRoot 副本，只能应答 businessPaths 外同源路径）；
 * MSW 经入口重放的 worker.start() 由项目自身代码启用；其余来源仍只识别不执行。
 *
 * 识别依据（只读 package.json 与文件存在性，不读取 .env*，不 import 任何项目文件）：
 *   - 依赖：vite-plugin-mock、mockjs、msw、json-server、miragejs、axios-mock-adapter 等（列表放数据常量，可扩展）
 *   - 文件：public/mockServiceWorker.js（MSW）、mock/ 或 src/mock/ 目录、*.mock.(js|ts)
 *   - 构建配置中的 mock 插件引用只记"存在"，不解析其选项
 * 置信度：单一证据类别为 candidate；manifest 声明与文件/配置两类证据互证时才 confirmed。
 * confirmed 仍只表示"项目声明了该 Mock 设施"，不声称其在运行时实际启用。
 */

import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { DiagnosticCode } from '../../shared/errors.ts'
import type { Diagnostic } from '../../shared/contracts.ts'
import { scanProjectFiles } from '../../shared/project-files.ts'
import { readProjectManifest, readProjectText, type Confidence } from '../../shared/profile.ts'

export interface ProjectMockSource {
  kind: 'vite-plugin-mock' | 'mockjs' | 'msw' | 'json-server' | 'miragejs' | 'axios-mock-adapter' | 'mock-directory'
  /** 相对应用根的证据（package.json 字段路径或文件/目录）。 */
  evidence: string[]
  confidence: Confidence
}

/** 依赖名 → kind 的数据表；新增识别项只改这里。 */
export const MOCK_PACKAGES: Readonly<Record<string, ProjectMockSource['kind']>> = {
  'vite-plugin-mock': 'vite-plugin-mock',
  mockjs: 'mockjs',
  msw: 'msw',
  'json-server': 'json-server',
  miragejs: 'miragejs',
  'axios-mock-adapter': 'axios-mock-adapter',
}

/** package.json 中承载依赖声明的字段；按固定顺序遍历保证证据顺序确定。 */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
/** 构建配置文件名（与 shared/profile.ts 的 configTool 同集）；只按字符串引用识别，不加载其导出。 */
const BUILD_CONFIG_NAME = /^(?:(?:vite|webpack|rspack)\.config\.[cm]?[jt]s|vue\.config\.[cm]?js)$/
const MOCK_FILE_NAME = /(?:^|\/)[^/]*\.mock\.[cm]?[jt]s$/
const MOCK_DIRECTORIES = ['mock', 'src/mock'] as const
/** vite-plugin-mock 默认按 mockPath='mock' 消费同名单元；依赖声明与该目录互证才升级到 confirmed。 */
const VITE_PLUGIN_MOCK_DIRS = ['mock/', 'src/mock/'] as const

type EvidenceCategory = 'manifest' | 'file' | 'config'

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

/** 配置源码中对包名的带引号字面量引用；不含引号的命中视为注释或非依赖语境，不记证据。 */
function referencesPackage(source: string, name: string): boolean {
  return source.includes(`'${name}'`) || source.includes(`"${name}"`) || source.includes(`\`${name}\``)
}

export async function detectProjectMocks(appRoot: string): Promise<ProjectMockSource[]> {
  const found = new Map<ProjectMockSource['kind'], { categories: Set<EvidenceCategory>, evidence: Set<string> }>()
  const add = (kind: ProjectMockSource['kind'], category: EvidenceCategory, evidence: string) => {
    const entry = found.get(kind) ?? { categories: new Set<EvidenceCategory>(), evidence: new Set<string>() }
    entry.categories.add(category)
    entry.evidence.add(evidence)
    found.set(kind, entry)
  }
  const manifest = await readProjectManifest(join(appRoot, 'package.json'), appRoot)
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest?.[field]
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const name of Object.keys(dependencies).sort()) {
      const kind = MOCK_PACKAGES[name]
      if (kind) add(kind, 'manifest', `package.json ${field}.${name}`)
    }
  }
  const scan = await scanProjectFiles(appRoot, 5000)
  const paths = scan.files.map(file => relative(appRoot, file).split(sep).join('/'))
  if (paths.includes('public/mockServiceWorker.js')) add('msw', 'file', 'public/mockServiceWorker.js')
  for (const dir of MOCK_DIRECTORIES)
    if (await isDirectory(join(appRoot, dir))) add('mock-directory', 'file', dir + '/')
  for (const path of paths.sort()) {
    if (MOCK_FILE_NAME.test(path)) add('mock-directory', 'file', path)
    if (!BUILD_CONFIG_NAME.test(path.split('/').pop()!)) continue
    const source = await readProjectText(join(appRoot, path), appRoot)
    if (source === undefined) continue
    for (const [name, kind] of Object.entries(MOCK_PACKAGES).sort())
      if (referencesPackage(source, name)) add(kind, 'config', path)
  }
  const directories = VITE_PLUGIN_MOCK_DIRS.filter(dir => found.get('mock-directory')?.evidence.has(dir))
  if (directories.length && found.has('vite-plugin-mock'))
    for (const dir of directories) add('vite-plugin-mock', 'file', dir)
  return [...found.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([kind, entry]) => ({
    kind,
    evidence: [...entry.evidence].sort(),
    confidence: entry.categories.size >= 2 ? 'confirmed' : 'candidate',
  }))
}

/**
 * 计划层展示：knownDifferences 证据行 + 一条非阻断的信息性诊断（R3-3，R5-1e 起执行部分来源）。
 * `executed` 列出本策略真实执行的来源（Vite 下选项可解析的 vite-plugin-mock）；MSW 是否运行
 * 取决于入口重放是否执行 worker.start()，无法在计划期断言，如实标注「可能执行」。
 */
export function describeProjectMocks(
  sources: readonly ProjectMockSource[],
  executed: ReadonlySet<ProjectMockSource['kind']> = new Set(),
): { knownDifferences: string[], diagnostics: Diagnostic[] } {
  if (!sources.length) return { knownDifferences: [], diagnostics: [] }
  const kinds = sources.map(source => source.kind).join(', ')
  const status = (source: ProjectMockSource) => {
    if (executed.has(source.kind)) return 'executed by the Runner from a temporaryRoot copy '
      + '(execution inputs fingerprinted); it can only answer same-origin paths outside the declared businessPaths'
    if (source.kind === 'msw') return 'its worker.start() runs only when the replayed entry invokes it; '
      + 'matched requests are intercepted inside the document before the plugin layer sees them'
    return 'project mocks are never imported or executed by the preview'
  }
  return {
    knownDifferences: sources.map(source =>
      `Project mock source detected (${source.confidence}): ${source.kind} at ${source.evidence.join(', ')}; `
        + status(source)),
    diagnostics: [{
      code: DiagnosticCode.projectMockDetected, phase: 'plan',
      message: `The project declares its own mock setup (${kinds})`,
      hint: 'Scenario fixtures remain authoritative on declared businessPaths; reference the detected files '
        + 'when filling fixtures, or rewrite the mock boundary as a scenario "handlers" module',
    }],
  }
}
