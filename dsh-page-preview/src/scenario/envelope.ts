/**
 * 场景级响应包装（R6-1，`docs/r6-plan.md` §3 R6-1；方案 §7.2）。
 * 实现在 src/shared/envelope.ts：shared/config/schema.ts 的 validateConfig 需要 validateEnvelope，
 * shared 不得 import scenario（与 FIXTURE_PLACEHOLDER 放 shared/fixture-draft.ts 同例）。
 * 本文件保留计划中的引用路径，只做再导出。
 */
export { ENVELOPE_DATA_TOKEN, applyEnvelope, validateEnvelope } from '../shared/envelope.ts'
export type { EnvelopeConfig } from '../shared/envelope.ts'
