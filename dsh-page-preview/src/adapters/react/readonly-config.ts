/** React/Vite 构建入口/别名的静态读取（方案 §6.5；R5-7）；机制在 adapters/shared/readonly-config.ts，这里只定宿主口径。 */
import type { ReadonlyBuildConfig } from '../shared/readonly-config.ts'
import { readBuildConfig, VITE_CONFIG_NAMES } from '../shared/readonly-config.ts'

export type { ConfigAlias, ReadonlyBuildConfig } from '../shared/readonly-config.ts'
export { unwrap, property, VITE_CONFIG_NAMES } from '../shared/readonly-config.ts'

/** React 只支持 vite.config.*，统一按 'vite' 口径读取。 */
export async function readReactBuildConfig(appRoot: string): Promise<ReadonlyBuildConfig> {
  return readBuildConfig(appRoot, { names: VITE_CONFIG_NAMES, flavorOf: () => 'vite' })
}
