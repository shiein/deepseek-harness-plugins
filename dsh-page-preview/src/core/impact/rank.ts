/**
 * 候选排序与代表页选择（方案 §5.2、§9.1；R3 计划 R3-4）。纯函数，无 I/O。
 *
 * 规则（按优先级）：
 *   1. evidence：strong > medium > weak
 *   2. origin：agent-confirmed > workspace-observed > unknown（只影响排序，不改变证据强度）
 *   3. scope：page > component（同一改动同时到达页面与组件时优先页面）
 *   4. relation 链更短者优先；仍相同按 selector 稳定 JSON 字典序，保证结果确定
 * 共享资源（一个改动到达多个页面）只保留前 maxCandidates 个，其余计入 omitted，不静默丢弃。
 *
 * 注：scope 不在 Candidate 上；同一 selector 的 page/component 边在 analyzer 合并时已保留页面关系链，
 * 排序键中 scope 由 relation 是否含路由证据近似承担，不引入新字段。
 */

import type { Candidate } from '../../shared/contracts.ts'
import { fingerprintJson } from '../../shared/fingerprint.ts'

export interface RankedCandidates {
  candidates: Candidate[]
  omitted: number
}

const EVIDENCE_RANK: Record<Candidate['evidence'], number> = { strong: 0, medium: 1, weak: 2 }
const ORIGIN_RANK: Record<NonNullable<Candidate['origin']>, number> = {
  'agent-confirmed': 0, 'workspace-observed': 1, unknown: 2,
}

function compare(a: Candidate, b: Candidate): number {
  return (EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence])
    || (ORIGIN_RANK[a.origin ?? 'unknown'] - ORIGIN_RANK[b.origin ?? 'unknown'])
    // 页面关系链含路由证据（'route …'）时优先于纯组件关系。
    || (Number(b.relation.some(value => value.startsWith('route ')))
      - Number(a.relation.some(value => value.startsWith('route '))))
    || (a.relation.length - b.relation.length)
    || fingerprintJson(a.selector).localeCompare(fingerprintJson(b.selector))
}

export function rankCandidates(candidates: readonly Candidate[], maxCandidates = 3): RankedCandidates {
  const ordered = [...candidates].sort(compare)
  // 共享资源按改动文件分组（relation[0] 即改动文件）：每组只保留前 maxCandidates 个代表页。
  const groups = new Map<string, number>()
  const kept: Candidate[] = []
  let omitted = 0
  for (const candidate of ordered) {
    const key = candidate.projectId + '\x00' + (candidate.relation[0] ?? '')
    const count = groups.get(key) ?? 0
    if (count < maxCandidates) { kept.push(candidate); groups.set(key, count + 1) }
    else omitted += 1
  }
  return { candidates: kept, omitted }
}

/**
 * 是否构成"单一高置信度候选"（§9.1 自动动作的门槛）：恰好一个 strong 候选，
 * 零个或多个 strong 竞争者都返回 undefined；medium/weak 不构成高置信度。
 */
export function singleConfidentCandidate(ranked: RankedCandidates): Candidate | undefined {
  const strong = ranked.candidates.filter(candidate => candidate.evidence === 'strong')
  return strong.length === 1 ? strong[0] : undefined
}
