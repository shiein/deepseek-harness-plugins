/**
 * page_preview_stop（方案 §4.2、§9.2）。
 * 可重复调用；attach 只脱离；有残留资源时为 cleanup_failed 并返回清单，不标记 stopped。
 * all=true 仅作用于当前工作区、当前 DSH 会话拥有的预览。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'

export function stopTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_stop',
    description: 'Stop (or detach from) a preview you own. Use all=true to stop all your previews in this workspace, or recover=true to reclaim persisted plugin resources after a crash.',
    parameters: {
      previewId: { type: 'string' },
      all: { type: 'boolean' },
      recover: { type: 'boolean' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      return toJson(await registry.stop(args, exec))
    },
  })
}
