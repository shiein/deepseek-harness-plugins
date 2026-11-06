/** 同源工具选择器结构投影（方案 §4.2、§15.3）；锁定 SDK 子集不支持的细粒度约束由 canonical 边界拒绝。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateJsonSchemaValue, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { targetParameterSchema } from '../../src/host/tools/target-schema.ts'
import { targetSelectorSchema } from '../../src/shared/plan-schema.ts'

test('public tool oneOf structure is projected from every canonical target variant', () => {
  const wire = valueSchemaSpecToJsonSchema(targetParameterSchema())
  assert.equal(wire.oneOf?.length, targetSelectorSchema.options.length)
  for (const selector of [
    { kind: 'registered', id: 'page' }, { kind: 'story', id: 'story' },
    { kind: 'file', path: 'index.html', exportName: 'Page' },
    { kind: 'url', url: 'http://127.0.0.1:3000' },
    { kind: 'route', path: '/users/:id', params: { id: '1' }, query: { page: '2' } },
  ]) {
    assert.equal(targetSelectorSchema.safeParse(selector).success, true)
    assert.deepEqual(validateJsonSchemaValue(wire, selector), [])
  }
})

test('SDK rejects mixed selectors, unknown fields, missing fields and invalid kinds before execution', () => {
  const wire = valueSchemaSpecToJsonSchema(targetParameterSchema())
  for (const invalid of [null, {}, { kind: 'file' }, { kind: 'file', path: 'a', id: 'b' }, { kind: 'invalid', id: 'a' }, { kind: 'route', path: '/', query: [] }]) {
    assert.ok(validateJsonSchemaValue(wire, invalid).length > 0)
    assert.equal(targetSelectorSchema.safeParse(invalid).success, false)
  }
})

test('canonical boundary retains nonempty and string-map checks absent from the SDK DSL', () => {
  const wire = valueSchemaSpecToJsonSchema(targetParameterSchema())
  for (const invalid of [{ kind: 'file', path: '' }, { kind: 'route', path: '/', query: { page: 1 } }]) {
    assert.deepEqual(validateJsonSchemaValue(wire, invalid), [])
    assert.equal(targetSelectorSchema.safeParse(invalid).success, false)
  }
})
