/**
 * page_preview_write_scenario（方案 §4.2、§7.2；R5-1a）：把 Agent 填好的场景定义写回
 * page-preview.config.json。占位标记未替换、同名场景已存在或项目由 local/explicit 配置时拒绝；
 * 只在用户经官方审批确认后写，已存在文件先备份可回滚。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderResult, toJson } from '../output.ts'
import type { SessionRegistry } from '../session-registry.ts'

export function writeScenarioTool(registry: SessionRegistry) {
  return defineTool({
    name: 'page_preview_write_scenario',
    description:
      'Write a filled scenario (e.g. a completed fixtureDraft.configSnippet entry) into the workspace ' +
      'page-preview.config.json for a project. The definition must satisfy the scenario schema and must ' +
      'not contain the fixture-draft placeholder; existing scenario names are never overwritten in ' +
      'create mode. In merge mode the named scenario must exist: http fixtures are appended only when ' +
      'their (method, origin, path, query) key is new, other scenario-level fields may only be added, ' +
      'and any conflict rejects the whole write with the conflicting keys listed. With applyTo set to ' +
      'a previewId, a successful write is applied in place through the existing refresh+scenario path. ' +
      'The user confirms the write in the DSH approval dialog; an existing config file is backed up first.',
    parameters: {
      projectId: { type: 'string', required: true },
      scenario: { type: 'string', required: true,
        description: 'Scenario name to create or, in merge mode, the existing scenario to append to.' },
      definition: { type: 'object', required: true, additionalProperties: true,
        description: 'The scenario object (businessPaths, http fixtures, identity, etc.) with real data filled in.' },
      mode: { type: 'string', enum: ['create', 'merge'],
        description: "create (default): write a new scenario, existing names are refused; " +
          "merge: append new fixture keys and new scenario-level fields to an existing scenario." },
      applyTo: { type: 'string',
        description: 'Optional previewId to switch to the written scenario in place after a successful write.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      return toJson(await registry.writeScenario(args, exec))
    },
  })
}
