/**
 * page_preview_status（方案 §4.2）：只读，不启动或修复服务。
 * 省略 previewId 时列出调用者在当前工作区拥有的预览，用于上下文压缩后找回 ID。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'

export function statusTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_status',
    description:
      'Read preview state, readiness evidence, freshness, capability gaps and recent diagnostics. ' +
      'Omit previewId to list your previews. Read-only.',
    parameters: {
      previewId: { type: 'string' },
      detail: { type: 'boolean', description: 'Include up to 32 recent diagnostics. With previewId, include the plan and capability table; execution environment values are omitted.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return toJson(await registry.status(args, exec))
    },
  })
}
