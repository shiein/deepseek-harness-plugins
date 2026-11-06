/** 适配器特性声明对照（R3-0）：每个适配器声明的 features 必须与旧 ID 分支行为一致。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adapters } from '../../src/adapters/registry.ts'

// 旧 controller.ts ID 分支的语义（docs/r3-plan.md §R3-0）：static 接受场景与断言但不接受隔离目标；
// vue-*/react-vite 三类全收；existing-server/project-command 三类全拒。
const EXPECTED: Record<string, { scenarios: boolean, targetAssertions: boolean, isolatedTarget: boolean }> = {
  static: { scenarios: true, targetAssertions: true, isolatedTarget: false },
  'vue-vite': { scenarios: true, targetAssertions: true, isolatedTarget: true },
  'vue-cli': { scenarios: true, targetAssertions: true, isolatedTarget: true },
  'react-vite': { scenarios: true, targetAssertions: true, isolatedTarget: true },
  'existing-server': { scenarios: false, targetAssertions: false, isolatedTarget: false },
  'project-command': { scenarios: false, targetAssertions: false, isolatedTarget: false },
}

test('every registered adapter declares features identical to the retired ID branches', () => {
  assert.deepEqual(adapters.map(adapter => adapter.id).sort(), Object.keys(EXPECTED).sort(),
    'the matrix below must be reviewed whenever an adapter is added or removed')
  for (const adapter of adapters)
    assert.deepEqual({ scenarios: adapter.features.scenarios,
      targetAssertions: adapter.features.targetAssertions,
      isolatedTarget: adapter.features.isolatedTarget }, EXPECTED[adapter.id], adapter.id)
})
