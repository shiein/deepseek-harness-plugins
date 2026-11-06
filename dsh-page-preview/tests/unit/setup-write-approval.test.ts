/** writeSetupTo 的官方确认接缝（方案 §6.9）：只有调用者会话内的官方 allowed-once 才算同意。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { requestSetupWriteApproval } from '../../src/host/setup-write-approval.ts'

const caller = { ownerSessionId: 'owner', workspaceRoot: '/ws' }
// 测试只用到 agent.session.id / name / callId / signal；其余字段与本接缝无关，按需构造后收窄类型。
const exec = (sessionId: string, signal = new AbortController().signal) =>
  ({ agent: { session: { id: sessionId } }, name: 'page_preview_open', callId: 'c1', signal }) as
    unknown as ToolRunContext

test('setup write approval is granted only by the official allowed-once answer in the caller session', async () => {
  const requests: Array<{ reason: string; displayReason?: { en: string; zh: string } }> = []
  const service = (answer: string) => ({
    request: async (input: never) => { requests.push(input); return answer as never },
  })
  assert.equal(await requestSetupWriteApproval(service('allowed-once'), caller, 'app', 'preview/setup.js',
    exec('owner')), 'approved')
  assert.match(requests[0]!.displayReason!.zh, /preview\/setup\.js/)
  assert.equal(await requestSetupWriteApproval(service('rejected'), caller, 'app', 'p.js', exec('owner')), 'rejected')
  assert.equal(await requestSetupWriteApproval(undefined, caller, 'app', 'p.js', exec('owner')), 'unavailable')
  assert.equal(await requestSetupWriteApproval(service('allowed-once'), caller, 'app', 'p.js', exec('other')),
    'unavailable', 'another session cannot approve writes into this caller workspace')
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await requestSetupWriteApproval(service('allowed-once'), caller, 'app', 'p.js',
    exec('owner', aborted.signal)), 'cancelled')
  assert.equal(requests.length, 2, 'unavailable/cancelled paths never open a dialog')
})
