/** Phase 0 独立包构建（方案 §4.1、§14），使用 SDK 的显式 wire schema；不改产品构建。 */
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageDir = fileURLToPath(new URL('../dev/bridge/', import.meta.url))
await build({
  entryPoints: { host: packageDir + 'host.mts', 'typert.host': packageDir + 'protocol.ts' },
  outdir: packageDir + 'lib', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'es2023',
})
await build({
  entryPoints: [packageDir + 'client.mts'], outfile: packageDir + 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2018',
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-page-preview-phase0-bridge",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports}})' },
})
console.log('Phase 0 carrier package built with strict SDK Remote descriptors')
