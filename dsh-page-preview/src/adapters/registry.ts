/**
 * 已注册适配器。adapter 配置值是这里的 ID，不是需要下载的 npm 包（§8）。
 * 只有通过样本验证的组合才在能力表中声明支持（§3.2）。
 */

import { staticAdapter } from './static/index.ts'
import { existingServerAdapter } from './existing-server/index.ts'
import { projectCommandAdapter } from './project-command/index.ts'
import { vueViteAdapter } from './vue/vite/index.ts'
import { vueCliAdapter } from './vue/cli/index.ts'
import { reactViteAdapter } from './react/vite/index.ts'
import type { Adapter } from './types.ts'

export const adapters: readonly Adapter[] = [
  staticAdapter,
  existingServerAdapter,
  projectCommandAdapter,
  vueViteAdapter,
  vueCliAdapter,
  reactViteAdapter,
]

export function getAdapter(id: string): Adapter | undefined {
  return adapters.find((adapter) => adapter.id === id)
}
