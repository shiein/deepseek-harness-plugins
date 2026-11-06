/** 工具调用者与工作区（方案 §4.1、§4.2、§8、§9.2）；使用不可变会话创建目录，cd 不改变预览归属。 */
import type { Session } from '@deepseek-ai/dsh-session'
import { isAbsolute } from 'node:path'
import { canonicalPath } from '../shared/config/paths.ts'

export interface PreviewCaller {
  ownerSessionId: string
  workspaceRoot: string
}

export class PreviewCallerError extends Error {
  constructor(cause?: unknown) {
    super('Preview requires a caller session with an explicit workspace directory', { cause })
    this.name = 'PreviewCallerError'
  }
}

export async function resolvePreviewCaller(session: Pick<Session, 'id' | 'header'> | undefined): Promise<PreviewCaller> {
  const cwd = session?.header.cwd
  if (!session?.id || !cwd || !isAbsolute(cwd)) throw new PreviewCallerError()
  try { return { ownerSessionId: session.id, workspaceRoot: await canonicalPath(cwd) } }
  catch (error) { throw new PreviewCallerError(error) }
}
