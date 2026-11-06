import type { Context } from '@deepseek-ai/cordis'
import type { SessionRegistry } from '../session-registry.ts'
import { captureTool } from './capture.ts'
import { openTool } from './open.ts'
import { refreshTool } from './refresh.ts'
import { statusTool } from './status.ts'
import { stopTool } from './stop.ts'
import { writeScenarioTool } from './write-scenario.ts'

export function registerTools(ctx: Context, registry: SessionRegistry) {
  ctx.tools.register(openTool(registry))
  ctx.tools.register(statusTool(registry))
  ctx.tools.register(refreshTool(registry))
  ctx.tools.register(captureTool(registry))
  ctx.tools.register(stopTool(registry))
  ctx.tools.register(writeScenarioTool(registry))
}
