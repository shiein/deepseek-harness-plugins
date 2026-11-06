/**
 * 「已配置 runtime.setup 是否漏掉入口样式导入」的只读核对（任务 C，2026-11-03；
 * F9 自 vue/react setup-styles.ts 抽取）。
 *
 * 检查范围（静态、只读，不执行项目代码，不读 .env*）：
 * - 入口侧：parseEntryRegistrations 产出的 style-import 注册项——顶层 import 说明符以样式
 *   扩展名（css/scss/sass/less/styl/stylus）结尾者。经普通 JS 模块间接引入的样式不在本轮。
 * - setup 侧：setup 文件本身的 module 引用，加上它直接 import 的本地模块的 module 引用
 *   （深度 1）。setup 经更深间接链、运行时条件导入或 CSS @import 引入样式时无法静态证明，
 *   因此诊断措辞一律用 "may be missing"，不作为事实断言。
 *
 * 说明符解析复用各框架 entry-replay.ts 的 resolveModuleSpecifier（与入口重放同一套
 * 别名/opaque/三方判定规则），经 hooks 注入，不新造解析器。比对以规范身份为准：
 * 本地文件为规范化绝对路径，三方/opaque 说明符为原字符串。
 */
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseScriptSource } from '../../shared/javascript.ts'
import { resolveProjectPath } from '../../shared/config/paths.ts'
import { projectDependencyNames, readProjectManifest, readProjectText } from '../../shared/profile.ts'

/** 与入口重放同一形状的只读解析结果；只消费 style-import 注册项与 imports 身份映射。 */
export interface SetupStylesEntryReplay {
  invalid: boolean
  registrations: readonly { kind: string, source: string }[]
  draft: { imports: readonly { source: string, resolvedSource?: string }[] }
}

/** 框架差异注入点（F9）：入口重放、说明符解析、脚本模块判定（Vue 含 .vue）。 */
export interface SetupStylesHooks<C> {
  parseEntry(appRoot: string, entryFile: string): Promise<SetupStylesEntryReplay>
  resolveSpecifier(config: C, dependencies: ReadonlySet<string>, root: string,
    importerFile: string, specifier: string): string | undefined
  scriptModule(file: string): boolean
}

/**
 * 返回入口声明了、但 setup（及其深度 1 本地模块）未覆盖的样式说明符，去重后保持
 * parseEntryRegistrations 的行序（同一行内不可重放的项会排在可重放项之前）。
 * entryFile/setupFile 为绝对路径；任何一步只读分析失败都返回空——核对是建议性的，
 * 无法证明不代表缺失，诊断由调用方措辞为 "may be missing"。
 */
export async function missingSetupStyles<C>(appRoot: string, entryFile: string, setupFile: string,
  config: C, hooks: SetupStylesHooks<C>): Promise<string[]> {
  const root = await realpath(appRoot)
  const replay = await hooks.parseEntry(appRoot, entryFile)
  if (replay.invalid) return []
  const wanted = replay.registrations.filter(registration => registration.kind === 'style-import')
  if (!wanted.length) return []
  const identity = new Map(replay.draft.imports.map(item => [item.source, item.resolvedSource ?? item.source]))
  const manifest = join(root, 'package.json')
  const dependencies = new Set(projectDependencyNames(await readProjectManifest(manifest, root), manifest))
  const covered = new Set<string>()
  const seen = new Set<string>()
  const collect = async (file: string, expand: boolean): Promise<void> => {
    const source = await readProjectText(file, root)
    if (source === undefined) return
    for (const reference of parseScriptSource(file, source).references) {
      if (reference.kind !== 'module') continue
      const resolved = hooks.resolveSpecifier(config, dependencies, root, file, reference.value)
      // 解析不出时身份即原说明符（与入口侧 resolvedSource ?? specifier 同一兜底）。
      if (resolved === undefined) { covered.add(reference.value); continue }
      covered.add(resolved)
      if (!expand || !isAbsolute(resolved) || !hooks.scriptModule(resolved) || seen.has(resolved)) continue
      seen.add(resolved)
      // 深度 1：跟随 setup 直接 import 的本地模块，把它们自身的引用也算作已覆盖。
      const canonical = await resolveProjectPath(root, relative(root, resolved) || '.').catch(() => undefined)
      if (canonical !== undefined) await collect(canonical, false)
    }
  }
  const canonicalSetup = await resolveProjectPath(root, relative(root, resolve(root, setupFile)) || '.')
    .catch(() => undefined)
  if (canonicalSetup === undefined) return []
  await collect(canonicalSetup, true)
  const missing = new Map<string, string>()
  for (const registration of wanted) {
    const key = identity.get(registration.source) ?? registration.source
    if (!covered.has(key) && !missing.has(key)) missing.set(key, registration.source)
  }
  return [...missing.values()]
}
