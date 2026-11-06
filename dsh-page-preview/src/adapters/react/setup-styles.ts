/**
 * 「已配置 runtime.setup 是否漏掉入口样式导入」的只读核对（任务 C，2026-11-03；R5-7 React 版）。
 * 机制在 adapters/shared/setup-styles.ts；这里只绑定 React 钩子：入口重放用
 * react/entry-replay.ts，脚本模块判定为 JS/TS/JSX/TSX。
 */
import { missingSetupStyles as sharedMissing } from '../shared/setup-styles.ts'
import { parseEntryRegistrations, resolveModuleSpecifier } from './entry-replay.ts'
import type { ReadonlyBuildConfig } from './readonly-config.ts'

const scriptModule = (file: string) => /\.[cm]?[jt]sx?$/i.test(file)

/** 返回入口声明了、但 setup（及其深度 1 本地模块）未覆盖的样式说明符。 */
export async function missingSetupStyles(appRoot: string, entryFile: string, setupFile: string,
  config: ReadonlyBuildConfig): Promise<string[]> {
  return sharedMissing(appRoot, entryFile, setupFile, config,
    { parseEntry: parseEntryRegistrations, resolveSpecifier: resolveModuleSpecifier, scriptModule })
}
