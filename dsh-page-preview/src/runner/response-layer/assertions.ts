/** 同一次浏览器断言结果的证据（方案 §6.8、§9.2）；不累计不同 DOM 时刻的部分成功。 */
import type { Evidence, TargetAssertion } from '../../shared/contracts.ts'
import type { BrowserReport } from './report-channel.ts'

export function sameDocumentUrl(reported: string, expected: string): boolean {
  try {
    const actual = new URL(reported)
    const target = new URL(expected)
    const query = (url: URL) => JSON.stringify([...url.searchParams].sort())
    return actual.origin === target.origin && actual.pathname === target.pathname && actual.hash === target.hash && query(actual) === query(target)
  } catch { return false }
}

export function assertionEvidence(assertions: readonly TargetAssertion[] | undefined, report: BrowserReport, expectedUrl: string): Evidence | undefined {
  if (report.kind !== 'assertions' || !assertions?.length || report.results.length !== assertions.length || !sameDocumentUrl(report.url, expectedUrl)) return undefined
  const pending = assertions.flatMap(({ kind }, index) => report.results[index] ? [] : [`#${index + 1} ${kind}`])
  if (!pending.length) return {
    status: 'proven', detail: 'All configured target assertions passed in the same browser observation',
  }
  const shown = pending.slice(0, 12)
  const omitted = pending.length - shown.length
  return { status: 'unverified', detail: 'Pending assertions: ' + shown.join(', ')
    + (omitted ? ` and ${omitted} more` : '') }
}
