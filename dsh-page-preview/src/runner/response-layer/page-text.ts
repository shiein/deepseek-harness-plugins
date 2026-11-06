/** 文本观察的目标绑定（方案 §4.2、§6.8、§9.2）；不据文本生成就绪、源码或截图证明。 */
import type { PageTextObservation } from '../../shared/contracts.ts'
import type { BrowserReport } from './report-channel.ts'
import { sameDocumentUrl } from './assertions.ts'

export function observePageText(report: BrowserReport, targetUrl: string): PageTextObservation | undefined {
  if (report.kind !== 'page-text' || !sameDocumentUrl(report.url, targetUrl)) return undefined
  return { text: report.text, truncated: report.truncated, url: targetUrl, receivedAt: new Date().toISOString() }
}
