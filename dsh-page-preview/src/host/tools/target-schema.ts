/** 选择器契约到锁定 SDK DSL 的结构投影（方案 §4.2）；字段/分支来自同一 Zod schema，Registry 保留完整语义校验。 */
import { z } from 'zod'
import type { ObjectValueSchemaSpec, ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { targetSelectorSchema } from '../../shared/plan-schema.ts'

/** SDK 仅支持 boolean additionalProperties；字符串映射和非空约束仍由 canonical schema 校验。 */
export function targetParameterSchema(): ParameterPropertySpec {
  const schema = z.toJSONSchema(targetSelectorSchema)
  const [first, second, ...others] = (schema.oneOf ?? []).map(projectNode)
  if (!first || !second) throw new Error('Target selector schema must contain at least two variants')
  return { oneOf: [first, second, ...others], description: 'Exactly one registered/file/route/story/url selector. Omit to receive candidates; discovery alone does not choose a task target.' }
}

function projectNode(schema: z.core.JSONSchema.JSONSchema | boolean): ValueSchemaSpec {
  if (typeof schema === 'boolean') throw new Error('Boolean selector schemas cannot be projected')
  if (schema.type === 'string') {
    if (schema.const !== undefined && typeof schema.const !== 'string') throw new Error('Invalid selector string constant')
    return { type: 'string', ...(typeof schema.const === 'string' ? { const: schema.const } : {}) }
  }
  if (schema.type === 'boolean') return { type: 'boolean' }
  if (schema.type === 'object') {
    const required = new Set(schema.required ?? [])
    const properties: NonNullable<ObjectValueSchemaSpec['properties']> = {}
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      properties[name] = { ...projectNode(child), ...(required.has(name) ? { required: true } : {}) }
    }
    return { type: 'object', properties, additionalProperties: schema.additionalProperties !== false,
      ...(schema.additionalProperties && typeof schema.additionalProperties === 'object' ? { description: 'Every property value must be a string; enforced again at the preview boundary.' } : {}),
    }
  }
  throw new Error('Unsupported target selector shape in SDK projection')
}
