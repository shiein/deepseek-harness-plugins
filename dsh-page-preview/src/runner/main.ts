/** Runner 子进程入口（方案 §6.5、§9.2）；显式执行才安装 IPC，断连/信号/异常先收束自有资源。 */
import { isAbsolute, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseHostMessage } from '../shared/plan-schema.ts'
import { runnerPaths } from '../shared/runner/paths.ts'
import type { RunnerToHost } from '../shared/ipc.ts'
import { DiagnosticCode } from '../shared/errors.ts'
import { RunnerController } from './controller.ts'

export async function runRunner(workspaceRoot: string, dataDir: string): Promise<void> {
  if (!process.send || !isAbsolute(workspaceRoot) || !isAbsolute(dataDir)) throw new Error('Runner requires IPC and absolute workspace/data directories')
  let controller: RunnerController | undefined
  let closing: Promise<void> | undefined
  let exitRequested = false
  const send = async (message: RunnerToHost) => {
    if (!process.connected || !process.send) return
    await new Promise<void>((resolve, reject) => process.send!(message, error => error && process.connected ? reject(error) : resolve()))
  }
  const finish = (code: number) => {
    exitRequested = true
    if (closing) return closing
    closing = (async () => {
      let finalCode = code
      try { if (controller && (await controller.shutdown()).status !== 'ok') finalCode = 1 }
      catch { finalCode = 1 }
      process.exit(finalCode)
    })()
    return closing
  }
  process.on('disconnect', () => { void finish(0) })
  process.on('SIGTERM', () => { void finish(0) })
  process.on('SIGINT', () => { void finish(0) })
  process.on('uncaughtException', () => { void finish(1) })
  process.on('unhandledRejection', () => { void finish(1) })
  const root = await realpath(workspaceRoot)
  controller = await RunnerController.create(root, dataDir, runnerPaths(dataDir, root).services, message => { void send(message).catch(() => finish(1)) })
  if (exitRequested) {
    await controller.shutdown()
    return
  }
  process.on('message', raw => {
    void (async () => {
      let message
      try { message = parseHostMessage(raw) }
      catch {
        const requestId = typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string' ? raw.requestId : undefined
        if (requestId) await send({ type: 'ack', requestId, ok: false, result: { status: 'error' }, diagnostics: [{ code: DiagnosticCode.configInvalid, phase: 'plan', message: 'Invalid Host IPC message' }] })
        return
      }
      if (exitRequested) return
      if (message.type === 'shutdown') exitRequested = true
      const ack = await controller!.handle(message)
      if (ack) await send(ack)
      if (message.type === 'shutdown') await finish(ack?.ok ? 0 : 1)
    })().catch(() => finish(1))
  })
  await send({ type: 'ready-for-commands', pid: process.pid, node: { executable: process.execPath, version: process.version } })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRunner(process.argv[2] ?? '', process.argv[3] ?? '').catch(() => {
    process.stderr.write('Runner initialization failed\n')
    process.exit(1)
  })
}
