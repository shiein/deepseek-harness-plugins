/** Phase 0 Remote 边界（方案 §4.1、§14）：schema 同时提供 TS 类型和两端严格编解码。 */
import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { RemoteResult, RemoteStreamHandle, TypertRemoteSpec, TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'

export const commandSchema = z.strictObject({
  id: z.number().int().min(1).max(3),
  kind: z.enum(['open', 'refresh', 'close']),
  url: z.string().url(),
})
export const replySchema = z.strictObject({
  id: z.number().int().min(1).max(3),
  status: z.enum(['accepted', 'error']),
  detail: z.string().max(512),
})
export type CarrierCommand = z.infer<typeof commandSchema>
export type CarrierReply = z.infer<typeof replySchema>

function codec(schema: z.ZodType, name: string): TypertRemoteCodecSpec {
  return { mode: 'strict', typeSymbol: name, create: () => schema, jsonSchema: z.toJSONSchema(schema) }
}
const sessionCodec = codec(z.string().min(1), 'ProbeSessionId')
const sessionParameter = { name: 'sessionId', source: 'json', codec: sessionCodec, strictCodec: sessionCodec } as const
const replyCodec = codec(replySchema, 'CarrierReply')
const spec = {
  package: 'dsh-page-preview-phase0-bridge',
  methods: {
    'pagePreviewPhase0/follow': {
      service: 'pagePreviewPhase0', invocation: { kind: 'direct' }, mode: 'stream',
      parameters: [sessionParameter], cancellation: { parameter: 'signal' },
      result: codec(commandSchema, 'CarrierCommand'),
    },
    'pagePreviewPhase0/acknowledge': {
      service: 'pagePreviewPhase0', invocation: { kind: 'direct' },
      parameters: [sessionParameter, { name: 'reply', source: 'json', codec: replyCodec, strictCodec: replyCodec }],
      result: { mode: 'strict', typeSymbol: 'void', create: () => z.void() },
    },
  },
} satisfies TypertRemoteSpec

const remoteInfo = createTypertRemoteInfo(spec, z)
export default remoteInfo

/** SDK Loader 支持显式 wire schema；这不是伪造的编译器反射结果。 */
export const TYPERT = {
  package: spec.package, face: 'host', schemas: [],
  get invocations() { return remoteInfo.descriptors },
  model: { services: [], events: [], objects: [] },
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    pagePreviewPhase0: {
      // Client 不能导入 Host Context 的类型增强；两端 sessions 服务并非同一接口。
      follow(sessionId: string, signal: AbortSignal): RemoteStreamHandle<CarrierCommand, never>
      acknowledge(sessionId: string, reply: CarrierReply): Promise<RemoteResult<void>>
    }
  }
}
