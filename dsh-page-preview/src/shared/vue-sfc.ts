/** Vue SFC 只读块摘要（方案 §5.2、§6.9）；插件 parse5 只提取顶层块，不加载项目编译器或尝试编译模板。 */
import { parseFragment } from 'parse5'

export interface SfcBlock {
  source: string
  lang: string
  src?: string
  setup: boolean
  line: number
}
export interface SfcSource {
  scripts: SfcBlock[]
  styles: SfcBlock[]
  template: boolean
  unresolved: string[]
}

export function parseVueSfc(source: string): SfcSource {
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true })
  const result: SfcSource = { scripts: [], styles: [], template: false, unresolved: [] }
  for (const node of fragment.childNodes) {
    if (!('tagName' in node)) continue
    if (!['script', 'style', 'template'].includes(node.tagName)) continue
    const location = node.sourceCodeLocation
    if (!location?.startTag || !location.endTag) { result.unresolved.push('Incomplete or self-closing SFC block requires compiler verification'); continue }
    const attributes = Object.fromEntries(node.attrs.map(value => [value.name, value.value]))
    if (node.tagName === 'template') {
      if (result.template) result.unresolved.push('Several SFC templates require compiler verification')
      result.template = true
      continue
    }
    const block: SfcBlock = {
      source: source.slice(location.startTag.endOffset, location.endTag.startOffset),
      lang: attributes.lang ?? (node.tagName === 'script' ? 'js' : 'css'),
      ...(attributes.src === undefined ? {} : { src: attributes.src }),
      setup: Object.hasOwn(attributes, 'setup'), line: location.startTag.startLine,
    }
    if (node.tagName === 'script') result.scripts.push(block)
    else result.styles.push(block)
  }
  if (result.scripts.length > 2 || result.scripts.filter(block => block.setup).length > 1 || result.scripts.filter(block => !block.setup).length > 1) result.unresolved.push('Several SFC script blocks require compiler verification')
  if (!result.template && !result.scripts.length) result.unresolved.push('No template or script component block was found')
  return result
}
