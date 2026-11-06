/** 产品 Client 打包（方案 §4.3）：esbuild 产出 DSH ModuleLoader 可加载的 client 与 wire 描述符。 */
import { fileURLToPath } from 'node:url'
import { relative } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
/**
 * Client 运行时 require 只能命中宿主 ModuleLoader 模块表里的名字（与官方 client 包一致：react、zod）。
 * `@deepseek-ai/dsh-typert-protocol/remote-info` 不在模块表里（2026-11-03 实机：
 * "missed the module table"），它是无运行时依赖的纯函数，因此打进 bundle；其余 @deepseek-ai 导入均为纯类型。
 */
const PROVIDED = ['react', 'react/jsx-runtime', 'zod']
const BUNDLED_PLATFORM = ['node_modules/@deepseek-ai/dsh-typert-protocol/']
const result = await build({
  entryPoints: [root + 'src/client/index.ts'], outfile: root + 'lib/client.js',
  bundle: true, platform: 'browser', format: 'cjs', target: 'es2018', metafile: true,
  external: PROVIDED,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-page-preview",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports}})' },
})
// 构建期门禁：运行时 require 只允许模块表内名字；被打进 bundle 的平台代码只允许上面列出的纯函数模块，
// 防止误把有单例/副作用的 @deepseek-ai 包复制进 Client。
const output = Object.values(result.metafile.outputs)[0]
const requires = [...new Set((output?.imports ?? []).map(value => value.path))]
const unexpected = requires.filter(name => !PROVIDED.includes(name))
const platform = Object.keys(result.metafile.inputs).map(file => relative(root, file))
  .filter(file => file.includes('node_modules/@deepseek-ai/') && !BUNDLED_PLATFORM.some(prefix => file.includes(prefix)))
if (unexpected.length || platform.length) {
  throw new Error('Client bundle drifted from the DSH module table: requires ' + JSON.stringify(unexpected)
    + ', bundled platform code ' + JSON.stringify(platform))
}
// Host/Client 两端各引一份 wire 描述符；TYPERT 与 remoteInfo 同在 protocol.ts。
await build({
  entryPoints: { 'typert.host': root + 'src/client/protocol.ts', 'typert.remote-client': root + 'src/client/protocol.ts' },
  outdir: root + 'lib', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'es2023',
})
console.log('Client bundle and wire descriptors built; client requires: ' + JSON.stringify(requires))
