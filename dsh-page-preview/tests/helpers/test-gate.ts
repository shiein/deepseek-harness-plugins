/**
 * Vue 集成测试的工具链门槛（P1-3，方案 §15.3）。
 * `DSH_PREVIEW_TEST_MODULES` 优先；缺省时回退仓库内自包含工具链（pretest 幂等安装），
 * 仍找不到才跳过。CI 环境（process.env.CI）下不允许跳过：缺少工具链或平台不支持时
 * 测试照常执行并由显式断言失败，杜绝 CI 靠跳过「全绿」。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const fallback = fileURLToPath(new URL('../toolchains/vue3-self-contained/node_modules', import.meta.url))
const reactFallback = fileURLToPath(new URL('../toolchains/react18-vite/node_modules', import.meta.url))

export const testModules = process.env.DSH_PREVIEW_TEST_MODULES ??
  (existsSync(fallback + '/vue/package.json') ? fallback : undefined)

/** React 18 + Vite 5 工具链（R5-7；docs/toolchains/react18-vite.package.json）。 */
export const reactModules = process.env.DSH_PREVIEW_TEST_REACT_MODULES ??
  (existsSync(reactFallback + '/react/package.json') ? reactFallback : undefined)

export const strict = Boolean(process.env.CI)

export const integrationSkip = (!['darwin', 'linux'].includes(process.platform) || !testModules) && !strict

export const reactIntegrationSkip = (!['darwin', 'linux'].includes(process.platform) || !reactModules) && !strict
