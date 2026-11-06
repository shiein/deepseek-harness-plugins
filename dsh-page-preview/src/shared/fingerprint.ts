/** 纯 JSON 数据的稳定指纹（方案 §6.7、§8）；不读取文件或环境，不回显参与哈希的值。 */
import { createHash } from 'node:crypto'
export function fingerprintJson(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)
  return createHash('sha256').update(canonical).digest('hex')
}
