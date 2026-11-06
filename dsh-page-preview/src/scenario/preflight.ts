/** 同源与跨源 HTTP 场景只读预检（方案 §6.2、§7.2、§8）；不启动服务，不执行项目 handler。 */
import { createHash } from 'node:crypto'
import type { ScenarioConfig } from '../shared/config/schema.ts'
import { DiagnosticCode, RunnerSessionError } from '../shared/errors.ts'
import { createMockMiddleware, validateChannelPath } from './mock-middleware.ts'
import { ScenarioStore } from './store.ts'
import { readScenarioBodyFile } from './files.ts'

export async function inspectScenarioFixtures(appRoot: string, scene: ScenarioConfig, dependencyRoots?: readonly string[]): Promise<Map<string, string>> {
  // R5-1c：显式 origin 的 fixture 经同源 remote 通道按原 origin 匹配，不再需要单独绑定；
  // businessPaths 只在有同源 fixture 或 handlers 时必需——纯跨源场景没有可推断的同源范围。
  const needsBusinessPaths = scene.handlers !== undefined || scene.http?.some(fixture => fixture.origin === undefined)
  if (needsBusinessPaths && !scene.businessPaths?.length) throw problem(DiagnosticCode.configInvalid, 'HTTP fixtures/handlers require explicit scenario.businessPaths; no API prefix was guessed')
  for (const fixture of scene.http ?? []) {
    if (fixture.origin === undefined) continue
    let parsed: URL
    try { parsed = new URL(fixture.origin) } catch { throw problem(DiagnosticCode.configInvalid, 'HTTP fixture origin must be a valid http(s) origin') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== fixture.origin || parsed.username || parsed.password) {
      throw problem(DiagnosticCode.configInvalid, 'HTTP fixture origin must be a canonical http(s) origin without credentials or path')
    }
  }
  try {
    const readBodyFile = (path: string) => readScenarioBodyFile(appRoot, path, dependencyRoots)
    createMockMiddleware({ previewOrigin: 'http://127.0.0.1:1', businessPaths: scene.businessPaths ?? [],
      fixtures: scene.http ?? [], ...(scene.envelope === undefined ? {} : { envelope: scene.envelope }),
      sse: scene.sse ?? [], store: new ScenarioStore('__preflight__'),
      readBodyFile, onUnmatched() {}, onDiagnostic() {} })
    // R5-1g：ws 通道与 SSE 同规则——字面量同源 pathname（schema 已排 query/hash，这里再排通配与坏编码）。
    for (const channel of scene.ws ?? []) validateChannelPath(channel.path)
    const files = new Map<string, string>()
    for (const fixture of scene.http ?? []) if (fixture.response.bodyFile) files.set(fixture.response.bodyFile, createHash('sha256').update(await readBodyFile(fixture.response.bodyFile)).digest('hex'))
    return files
  } catch (error) { throw problem(DiagnosticCode.configInvalid, 'Scenario HTTP paths, fixture responses or response file bindings are invalid; no project code was executed', error) }
}
function problem(code: string, message: string, cause?: unknown) { return new RunnerSessionError({ code, phase: 'plan', message, hint: 'Configure explicit same-origin fixture paths and files within the declared roots' }, cause) }
