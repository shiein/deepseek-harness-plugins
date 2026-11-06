/**
 * page_preview_refresh（方案 §4.2）：手动触发调用者自己预览的文档重载（兜底，R2-P0-2）。
 * 只对已绑定到调用者会话的预览生效；编译成功后通常经构建长轮询自动刷新，无需调用。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'

export function refreshTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_refresh',
    description:
      'Reload the document of a preview you own, e.g. after changing files that the build does not watch. ' +
      'With `scenario` it switches to another configured scenario; without it the current scenario data ' +
      '(fixtures etc.) is re-read, so fixture drafts filled into the config take effect without reopening. ' +
      'Returns the refreshed preview summary; compilation failures surface as stale freshness with diagnostics.',
    parameters: {
      previewId: { type: 'string', required: true },
      scenario: { type: 'string',
        description: 'Switch to another configured scenario. Omit to reload the current scenario data only.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      return toJson(await registry.refresh(args, exec))
    },
  })
}
