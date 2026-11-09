/** Vue 构建入口/别名的静态读取（方案 §6.5、§6.9）；机制在 adapters/shared/readonly-config.ts，这里只定宿主口径。 */
import type { ReadonlyBuildConfig } from '../shared/readonly-config.ts'
import { readBuildConfig, VITE_CONFIG_NAMES } from '../shared/readonly-config.ts'
import { CLI_CONFIG_NAMES } from '../../shared/config/fingerprint.ts'

export { CLI_CONFIG_NAMES }

export type { ConfigAlias, ReadonlyBuildConfig } from '../shared/readonly-config.ts'
export { unwrap, property, VITE_CONFIG_NAMES } from '../shared/readonly-config.ts'

/** vite.config.* 按 'vite' 口径读；vue.config.* 按 'cli' 口径读（configureWebpack/pages）。 */
export async function readVueBuildConfig(appRoot: string,
  host?: 'vite' | 'vue-cli'): Promise<ReadonlyBuildConfig> {
  const names = host === 'vite' ? VITE_CONFIG_NAMES
    : host === 'vue-cli' ? CLI_CONFIG_NAMES : [...VITE_CONFIG_NAMES, ...CLI_CONFIG_NAMES]
  return readBuildConfig(appRoot, { names, flavorOf: name => name.startsWith('vite.') ? 'vite' : 'cli' })
}
