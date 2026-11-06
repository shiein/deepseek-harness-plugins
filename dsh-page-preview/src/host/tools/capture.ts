/**
 * page_preview_capture（方案 §4.2、§9.3）。
 * 默认只采集 current-view；没有该能力返回 unsupported_capability，不偷偷改用另一个浏览器重放。
 *
 * TODO(phase0): dsh-llm 注释表明当前生产适配器只有 user content 携带图片；
 *   验证 tool-result 中的 image block 能否送达模型，再决定 render 是否附带图片。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'

export function captureTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_capture',
    description: 'Capture the current preview view to a local file with full context (scenario, freshness, fingerprints).',
    parameters: {
      previewId: { type: 'string', required: true },
      fullPage: { type: 'boolean' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      return toJson(await registry.capture(args, exec))
    },
  })
}
