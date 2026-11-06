/** Vite 自有 HMR Upgrade 边界（方案 §6.8、§7.3）；Node 24.9 起的原生准入先于项目 listener，不构造第二套 WS 服务。 */
import type { IncomingMessage } from 'node:http'
import semver from 'semver'
import { VITE_HMR_PATH } from './paths.ts'

/** 当前核对的 Node 24 API 线；其他运行时不凭忽略未知选项宣称控制。 */
export function hasUpgradeGate(nodeVersion = process.versions.node): boolean {
  return semver.satisfies(nodeVersion, '>=24.9.0 <25.0.0')
}

export function isOwnedHmrUpgrade(request: IncomingMessage): boolean {
  const port = request.socket.localPort
  const host = '127.0.0.1:' + port
  return port !== undefined && request.method === 'GET' && request.url === VITE_HMR_PATH &&
    request.headers.upgrade?.toLowerCase() === 'websocket' && request.headers['sec-websocket-protocol'] === 'vite-hmr' &&
    request.headers.host === host && request.headers.origin === 'http://' + host
}
