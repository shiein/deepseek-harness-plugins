/**
 * 模型可见输出的统一脱敏规则（方案 §13 第 8 条）。
 * 所有进入诊断、pageText、计划展示的文本先经同一策略处理：像密钥的 env 值/通道 nonce 按值替换为
 * [redacted]（secretLike 判定：敏感键名或长值），Cookie/Authorization 头值去除，URL 去 userinfo/query，结果限长并注明截断。
 * Runner 侧在发出消息前应用；Host 侧在工具输出边界再用其已知值复查一遍。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const REDACTED = '[redacted]'
/** 单条诊断文本字段的上限；code frame 更短。 */
export const DIAGNOSTIC_TEXT_LIMIT = 4096
export const CODE_FRAME_LIMIT = 2048
/** 运行时错误转发的最大堆栈帧数。 */
export const STACK_FRAME_LIMIT = 5
const TRUNCATED = '…[truncated]'
const AUTH_HEADER = /(authorization|cookie)\s*[:=]\s*[^\r\n]+/gi

export interface RedactionSource {
  /** 按值替换的敏感串（runtime.env 值与项目 env 文件值）；空值忽略，长的先替换。 */
  readonly secrets?: readonly string[]
  /** 回传 nonce 等通道值；与 secrets 同规则替换。 */
  readonly channels?: readonly string[]
}

export interface Redactor {
  /** 任意模型可见文本：值替换与认证头去除后限长截断。 */
  text(value: string, limit?: number): string
  /** URL 文本：去 userinfo、query、fragment 后值替换；无法解析时退化为尾部剥离的 text。 */
  url(value: string, limit?: number): string
  /**
   * 仅用于内部目标核对的地址：去 userinfo 并做值替换，但保留 query——
   * sameDocumentUrl 要按完整 query 验证同一份文档；这些值不得直接转发给模型。
   */
  address(value: string, limit?: number): string
  /** 被拦截请求的三元组：method、origin、path（query 已去除）。 */
  request(method: string | undefined, rawUrl: string, base?: string): { method?: string; origin?: string; path: string }
  /** 运行时错误堆栈：保留消息行与前 N 帧，其余截断注明。 */
  stack(value: string, frames?: number): string
}

export function createRedactor(source: RedactionSource = {}): Redactor {
  const secrets = [...new Set([...(source.secrets ?? []), ...(source.channels ?? [])].filter(value => value.length > 0))]
    .sort((a, b) => b.length - a.length)
  const replace = (value: string): string => {
    let out = value
    for (const secret of secrets) out = out.split(secret).join(REDACTED)
    AUTH_HEADER.lastIndex = 0
    return out.replace(AUTH_HEADER, (_, name: string) => name + ': ' + REDACTED)
  }
  const limit = (value: string, max: number) => value.length <= max ? value : value.slice(0, max) + TRUNCATED
  return {
    text: (value, max = DIAGNOSTIC_TEXT_LIMIT) => limit(replace(value), max),
    url(value, max = DIAGNOSTIC_TEXT_LIMIT) {
      try {
        const parsed = new URL(value)
        parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
        return limit(replace(parsed.toString().replace(/\/$/, '')), max)
      } catch { return limit(replace(value.replace(/[?#][^\s]*$/, '')), max) }
    },
    address(value, max = DIAGNOSTIC_TEXT_LIMIT) {
      try {
        const parsed = new URL(value)
        parsed.username = ''; parsed.password = ''
        return limit(replace(parsed.toString()), max)
      } catch { return limit(replace(value), max) }
    },
    request(method, rawUrl, base) {
      try {
        const parsed = new URL(rawUrl, base)
        return { ...(method === undefined ? {} : { method }), origin: replace(parsed.origin), path: limit(replace(parsed.pathname), DIAGNOSTIC_TEXT_LIMIT) }
      } catch { return { ...(method === undefined ? {} : { method }), path: limit(replace(rawUrl.replace(/[?#][^\s]*$/, '')), DIAGNOSTIC_TEXT_LIMIT) } }
    },
    stack(value, frames = STACK_FRAME_LIMIT) {
      const lines = value.split('\n')
      const kept: string[] = []
      let seen = 0
      for (const line of lines) {
        const isFrame = /^\s*at\s/.test(line)
        if (isFrame) seen += 1
        if (isFrame && seen > frames) { kept.push(TRUNCATED); break }
        kept.push(line)
      }
      return limit(replace(kept.join('\n')), DIAGNOSTIC_TEXT_LIMIT)
    },
  }
}

/** dotenv 风格 KEY=VALUE 行解析为名值对（键名参与 secretLike 判定）；忽略注释/空值，引号剥离。 */
export interface EnvPair { name: string; value: string }
export function parseEnvPairs(text: string): EnvPair[] {
  const pairs: EnvPair[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2]!.trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    else value = value.split(/\s+#/)[0]!.trimEnd()
    if (value) pairs.push({ name: match[1]!, value })
  }
  return pairs
}

/** 模板 env 文件（.env.example/.env.sample 等分发模板）不参与收集——模板值会误伤普通文本。 */
const ENV_TEMPLATE = /\.(example|sample|template|defaults?|dist)$/i
export async function collectEnvPairs(root: string): Promise<EnvPair[]> {
  const names = await readdir(root).catch(() => [] as string[])
  const pairs: EnvPair[] = []
  for (const name of names.filter(name => /^\.env(\..*)?$/.test(name) && !ENV_TEMPLATE.test(name))) {
    const text = await readFile(join(root, name), 'utf8').catch(() => '')
    pairs.push(...parseEnvPairs(text))
  }
  return pairs
}

/** 敏感键名按分段判定（BYPASS 不含 PASS 段）；段以 KEY/TOKEN/SECRET 结尾（APIKEY、ACCESSTOKEN）同样敏感。 */
const SECRET_SEGMENTS = new Set(['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD', 'AUTH', 'COOKIE',
  'SESSION', 'PRIVATE', 'CREDENTIAL', 'CREDENTIALS', 'DSN', 'SALT', 'SIGNATURE'])
const SECRET_SUFFIX = /(KEY|TOKEN|SECRET)$/
/** 键名同时带配置语义段时（AUTH_ENABLED、SESSION_TIMEOUT、TOKEN_TTL）值是开关/数值/地址，不按键名判密钥。 */
const CONFIG_SEGMENTS = new Set(['ENABLE', 'ENABLED', 'DISABLE', 'DISABLED', 'MODE', 'TYPE', 'TIMEOUT', 'TTL',
  'EXPIRE', 'EXPIRES', 'EXPIRY', 'MAX', 'MIN', 'COUNT', 'SIZE', 'LENGTH', 'URL', 'URI', 'PATH', 'HOST', 'PORT',
  'NAME', 'VERSION', 'PREFIX', 'HEADER', 'FIELD'])
const BOOLEAN_VALUE = /^(true|false)$/i
const NUMBER_VALUE = /^-?[\d.]+$/
const PLAIN_ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9._~-]+(:\d{1,5})?\/?$/i

function sensitiveName(name: string): boolean {
  const segments = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  if (segments.some(segment => CONFIG_SEGMENTS.has(segment))) return false
  return segments.some(segment => SECRET_SEGMENTS.has(segment) || SECRET_SUFFIX.test(segment))
}

/**
 * "像密钥"的判定。布尔值从不当密钥（true/false 被全文替换会毁掉诊断）；敏感键名下纯数字至少 8 位
 * （1800/3600 这类超时值与行号同形）、其余值至少 4 位；非敏感键名只把 ≥12 且非数字/布尔/普通 origin 的长值当密钥。
 */
export function secretLike(name: string, value: string): boolean {
  if (!value || BOOLEAN_VALUE.test(value)) return false
  if (sensitiveName(name)) return NUMBER_VALUE.test(value) ? value.length >= 8 : value.length >= 4
  return !(value.length < 12 || NUMBER_VALUE.test(value) || PLAIN_ORIGIN.test(value))
}

/** runtime.env 与 env 文件值中"像密钥"的值合并为统一 secrets 列表；短值与普通值不替换。 */
export function envSecrets(env: Record<string, string> | undefined, filePairs: readonly EnvPair[]): string[] {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(env ?? {})) if (secretLike(name, value)) secrets.push(value)
  for (const pair of filePairs) if (secretLike(pair.name, pair.value)) secrets.push(pair.value)
  return [...new Set(secrets)]
}
