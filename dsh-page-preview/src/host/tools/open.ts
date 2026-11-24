/**
 * page_preview_open（方案 §4.2）。
 *
 * 语义要点：
 * - 有界等待：等待窗口内拿到启动结果就返回；否则返回当前 state（preparing/starting）与 previewId。
 * - 同一会话重复 open 同一目标时，优先返回或更新现有预览；需要重启时在诊断中说明。
 * - requirements 只能按授权放宽，'auto' 不得隐式放宽。
 *
 * 受理后等待窗口为 2 秒（状态仍取 Runner）；独立 Runner 初始化/请求另有明确截止时间。
 * Phase 0 已验证协作取消；原生产品中的耗时/截止时间仍须在安装验收时核对。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'
import { targetParameterSchema } from './target-schema.ts'

export function openTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_open',
    description:
      'Open or reuse a preview of a real page in the project. Returns state and capability gaps. ' +
      'For file targets, use a workspace-relative path without projectId (e.g. web/src/views/x/index.vue), ' +
      'or an application-relative path with projectId (e.g. src/views/x/index.vue). ' +
      'Use the discovered or configured projectId; do not guess it. Pass a page or component file ' +
      '(.vue/.tsx/.jsx), or a declared project route: {"kind": "route", "path": "/users/1"} (optionally with ' +
      'params/query and "layout": true to render the parent layout chain; the project must configure ' +
      'runtime.setup with a navigate binding). story/URL targets need configuration. ' +
      'Follow each diagnostic hint literally (config fields, setup module, user approval). ' +
      'When the user has this session on screen, the preview opens automatically in the DSH sidebar Browser; ' +
      'For a plain preview, set waitFor: "mount" to return after browser feedback while assertions continue. ' +
      'Report the sidebar and the observed mount status. For an open request, do not poll, take screenshots, ' +
      'create fixtures or add assertions. Otherwise give the user the URL; never launch a separate browser. ' +
      'Report preparing/starting as in progress. For an explicit verification request, use page_preview_status ' +
      'with detail:true for the full plan and diagnostics.',
    parameters: {
      projectId: { type: 'string', description: 'Application id. Required when several apps match.' },
      target: targetParameterSchema(),
      scope: { type: 'string', enum: ['page', 'component', 'shell'] },
      strategy: { type: 'string', enum: ['auto', 'static', 'isolated', 'project', 'attach'] },
      scenario: { type: 'string' },
      waitFor: {
        type: 'string', enum: ['mount', 'assertions'],
        description: 'Choose mount for a quick preview or assertions to wait for configured verification (default).',
      },
      viewport: {
        type: 'object',
        additionalProperties: false,
        properties: {
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      requirements: {
        type: 'array',
        items: { type: 'string', enum: ['isolated-target', 'mock-only'] },
      },
      writeSetupTo: {
        type: 'string',
        description:
          'Write a generated setup draft into the project at this new path relative to the application root, ' +
          'e.g. preview/setup.js. The user confirms the write in the DSH approval dialog; existing files are ' +
          'never overwritten and the draft never auto-executes.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      return toJson(await registry.open(args, exec))
    },
  })
}
