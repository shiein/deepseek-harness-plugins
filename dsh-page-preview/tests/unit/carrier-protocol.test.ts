/** Phase 0 Remote 系统边界失败路径（方案 §4.1、§15.2）。不连接 DSH 或模型服务。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import remoteInfo, { commandSchema, replySchema } from '../../dev/bridge/protocol.ts'

test('carrier commands reject unknown operations, invalid ids and extra fields', () => {
  const command = { id: 1, kind: 'open', url: 'http://127.0.0.1:1234/' }
  assert.deepEqual(commandSchema.parse(command), command)
  for (const value of [
    { ...command, kind: 'evaluate' }, { ...command, id: 0 },
    { ...command, url: 'not-a-url' }, { ...command, script: 'untrusted' },
  ]) assert.equal(commandSchema.safeParse(value).success, false)
})

test('carrier acknowledgement cannot claim target readiness', () => {
  assert.equal(replySchema.safeParse({ id: 1, status: 'ready', detail: '' }).success, false)
  assert.equal(replySchema.safeParse({ id: 1, status: 'accepted', detail: 'x'.repeat(513) }).success, false)
  assert.equal(replySchema.safeParse({ id: 1, status: 'accepted', detail: 'API invoked' }).success, true)
})

test('Remote descriptors validate strict input and reserve signal for transport', () => {
  const follow = remoteInfo.descriptors.find((item) => item.method === 'follow')
  const acknowledge = remoteInfo.descriptors.find((item) => item.method === 'acknowledge')
  assert.ok(follow && acknowledge)
  assert.equal(follow.mode, 'stream')
  assert.deepEqual(follow.parameters.map((item) => item.wire), ['sessionId'])
  assert.deepEqual(follow.cancellation, { parameter: 'signal' })
  const result = follow.result
  assert.equal(result.mode, 'strict')
  if (result.mode !== 'strict') throw new Error('Strict codec required')
  assert.throws(() => result.create().parse({ id: 1, kind: 'open', url: 'http://127.0.0.1/', hidden: true }))
  const reply = acknowledge.parameters[1]?.codec
  assert.ok(reply && reply.mode === 'strict')
  assert.throws(() => reply.create().parse({ id: 1, status: 'ready', detail: '' }))
})
