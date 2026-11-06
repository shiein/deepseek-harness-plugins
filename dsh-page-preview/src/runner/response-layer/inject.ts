/**
 * bootstrap 注入（方案 §6.8）：必须早于任何业务脚本执行。
 * 插入位置：真实 <head> 开始标签之后；没有时在 <html> 或 doctype 之后，保留文档模式。
 * 注入脚本只做观测与 Mock 桥接，不得修改业务逻辑。
 */

import { bootstrapInsertionPoint } from '../../shared/html.ts'

export function injectBootstrap(html: string, script: string): string {
  const tag = `<script data-dsh-preview-bootstrap>${escapeScriptBody(script)}</script>`
  const end = bootstrapInsertionPoint(html)
  return html.slice(0, end) + tag + html.slice(end)
}

/** 防止脚本内容提前闭合 <script>。 */
function escapeScriptBody(script: string): string {
  return script.replace(/<\/script/gi, '<\\/script')
}
