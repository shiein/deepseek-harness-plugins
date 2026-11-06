/** 自有 React Vite 执行器 IPC（方案 §6.5、§9.2；R5-7）；schema 在
 * adapters/vite/worker-protocol.ts，这里只绑定 react-vite 的 adapter id。 */
import { parseViteWorkerInput as parse } from '../../vite/worker-protocol.ts'
import type { ViteWorkerInput } from '../../vite/worker-protocol.ts'

export type { ViteWorkerInput, ViteHandlerReply, ViteScenarioUpdate,
  ViteWorkerOutput } from '../../vite/worker-protocol.ts'
export { parseViteHandlerReply, isViteScenarioUpdate, parseViteScenarioUpdate,
  parseViteWorkerOutput } from '../../vite/worker-protocol.ts'

export function parseViteWorkerInput(raw: unknown): ViteWorkerInput {
  return parse(raw, 'react-vite')
}
// 固定端点与虚拟模块身份与 vue-vite 共用（adapters/vite/paths.ts）；此处再导出保持既有引用不变。
export { VITE_PAGE_PATH, VITE_HMR_PATH, VITE_VIRTUAL_PREFIX, viteVirtualUrl } from '../../vite/paths.ts'
