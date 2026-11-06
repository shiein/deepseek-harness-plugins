/** HTML 只读结构（方案 §5.2、§6.8、§11）；使用解析树定位真实元素，保留原文，不执行脚本或序列化业务文档。 */
import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'

export interface HtmlReference {
  kind: 'script' | 'style' | 'asset' | 'frame'
  value: string
  module?: boolean
  preload?: true
}
export interface HtmlSource {
  references: HtmlReference[]
  inlineScripts: Array<{ source: string; module: boolean }>
  base?: string
  metaCsp: boolean
}

function* elements(node: DefaultTreeAdapterTypes.Node): Generator<DefaultTreeAdapterTypes.Element> {
  if ('tagName' in node) yield node
  if ('childNodes' in node) for (const child of node.childNodes) yield* elements(child)
  // template.content 不在活动文档中，不把其中的 script 当作立即执行的入口。
}

export function parseHtmlSource(source: string): HtmlSource {
  const result: HtmlSource = { references: [], inlineScripts: [], metaCsp: false }
  for (const element of elements(parse(source))) {
    const attrs = Object.fromEntries(element.attrs.map(value => [value.name, value.value]))
    if (element.tagName === 'base' && attrs.href !== undefined && result.base === undefined) result.base = attrs.href
    if (element.tagName === 'meta' && attrs['http-equiv']?.toLowerCase() === 'content-security-policy') result.metaCsp = true
    if (element.tagName === 'script') {
      const type = (attrs.type ?? '').trim().toLowerCase()
      if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue
      if (attrs.src) result.references.push({ kind: 'script', value: attrs.src, module: type === 'module' })
      else result.inlineScripts.push({ source: element.childNodes.map(node => 'value' in node ? node.value : '').join(''), module: type === 'module' })
    }
    if (element.tagName === 'link' && attrs.href) {
      const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
      if (rel.includes('stylesheet')) result.references.push({ kind: 'style', value: attrs.href })
      else if (rel.includes('modulepreload')) result.references.push({ kind: 'script', value: attrs.href, module: true, preload: true })
      else if (rel.includes('icon')) result.references.push({ kind: 'asset', value: attrs.href })
    }
    if (['img', 'source', 'audio', 'video'].includes(element.tagName) && attrs.src) result.references.push({ kind: 'asset', value: attrs.src })
    if (element.tagName === 'iframe' && attrs.src) result.references.push({ kind: 'frame', value: attrs.src })
  }
  return result
}

/** 不把注释、属性值、脚本文本中的 <head> 当作入口；无显式 head 时仍保留 doctype 位置。 */
export function bootstrapInsertionPoint(source: string): number {
  const document = parse(source, { sourceCodeLocationInfo: true })
  const all = [...elements(document)]
  for (const name of ['head', 'html']) {
    const node = all.find(value => value.tagName === name)
    const end = node?.sourceCodeLocation?.startTag?.endOffset
    if (end !== undefined) return end
  }
  const doctype = document.childNodes.find(node => node.nodeName === '#documentType')
  return doctype?.sourceCodeLocation?.endOffset ?? 0
}

/**
 * 预览文档沿用项目入口 HTML 的外壳（§0.3 第 10 条）：<html>/<body> 的静态属性（class、lang、dir、data-* 等，
 * 跳过 on* 事件属性与含模板占位符的值）与内联经典脚本（polyfill 等，按原顺序）。不复制外链资源与模块入口。
 */
export interface DocumentShell { htmlAttributes: string; bodyAttributes: string; inlineScripts: string[] }
export function documentShell(source: string): DocumentShell {
  const shell: DocumentShell = { htmlAttributes: '', bodyAttributes: '', inlineScripts: [] }
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const attributes = (element: DefaultTreeAdapterTypes.Element) => element.attrs
    .filter(attr => /^[a-z][a-z0-9-]*$/i.test(attr.name) && !/^on/i.test(attr.name) && !/<%|\{\{/.test(attr.value))
    .map(attr => ' ' + attr.name + '="' + escape(attr.value) + '"').join('')
  for (const element of elements(parse(source))) {
    if (element.tagName === 'html') shell.htmlAttributes = attributes(element)
    if (element.tagName === 'body') shell.bodyAttributes = attributes(element)
    if (element.tagName === 'script') {
      const attrs = Object.fromEntries(element.attrs.map(value => [value.name, value.value]))
      const type = (attrs.type ?? '').trim().toLowerCase()
      if (attrs.src !== undefined || type && !['text/javascript', 'application/javascript'].includes(type)) continue
      const text = element.childNodes.map(node => 'value' in node ? node.value : '').join('')
      if (text.trim() && !/<%/.test(text)) shell.inlineScripts.push(text.replace(/<\/script/gi, '<\\/script'))
    }
  }
  return shell
}
