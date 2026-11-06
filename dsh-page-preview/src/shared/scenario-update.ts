/**
 * 场景更新载荷（方案 §7.4、§11；R3 计划 R3-2）。shared 层：adapters 不 import runner 编排，
 * runner/scenario-reload.ts 与适配器 RunningHandle.switchScenario 共用同一类型。
 *
 * 只含数据：场景名、已校验的 ScenarioConfig、Runner 计算的新场景指纹。
 * 执行项（handlers/setup/command/env）不得在场景更新中变化——Runner 在 prepareScenarioUpdate
 * 里已用执行指纹拒绝；适配器/worker 收到本载荷只做数据面替换。
 */

import type { ScenarioConfig } from './config/schema.ts'

export interface ScenarioUpdate {
  /** 目标场景名；与当前 plan.scenario 相同表示重新读取该场景数据。 */
  name: string
  scenario: ScenarioConfig
  /** 新的场景指纹，写回 plan.fingerprints.scenario（与计划阶段同一算法）。 */
  fingerprint: string
}
