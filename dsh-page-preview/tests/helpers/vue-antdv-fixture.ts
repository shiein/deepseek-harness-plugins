/** Ant Design Vue 4 全量注册/Provider/命名 SFC 自有样本（方案 §6.9、§15）；只借用显式已有包，不执行来源项目。 */
import { readFile, realpath, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ProjectConfig } from '../../src/shared/config/schema.ts'
import type { createVueViteFixture } from './vue-vite-fixture.ts'

export async function prepareAntdvFixture(fixture: Pick<Awaited<ReturnType<typeof createVueViteFixture>>, 'appRoot' | 'put'>, project: ProjectConfig, modules: string) {
  const installed = await realpath(join(modules, 'ant-design-vue'))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
  if (metadata.version !== '4.2.5') throw new Error('Own sample requires explicit installed Ant Design Vue 4.2.5')
  await symlink(installed, join(fixture.appRoot, 'node_modules/ant-design-vue'))
  project.runtime.dependencyRoots = [relative(fixture.appRoot, await realpath(modules))]
  project.runtime.setup = 'reviewed-setup.js'
  project.runtime.styles = ['node_modules/ant-design-vue/dist/reset.css', 'theme.css']
  await fixture.put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4', 'ant-design-vue': '4.2.5' } }))
  await fixture.put('src/main.js', `import {createApp} from 'vue'; import Target from './Target.vue'; import Antd from 'ant-design-vue'; import 'ant-design-vue/dist/reset.css'; createApp(Target).use(Antd).mount('#app')`)
  await fixture.put('reviewed-setup.js', `import {h} from 'vue'
    import Antd, {ConfigProvider} from 'ant-design-vue'
    import zhCN from 'ant-design-vue/es/locale/zh_CN'
    export default {
      install({app}) { app.use(Antd); app.provide('sample-binding', 'Original setup installed') },
      createContext() { return {wrap: {setup(_, {slots}) {return () => h(ConfigProvider, {locale:zhCN, theme:{token:{colorPrimary:'#0f766e',borderRadius:4}}}, slots)}}} },
    }`)
  await fixture.put('theme.css', 'body { font-family: sans-serif; margin: 24px } article { max-width: 560px; padding: 20px; border: 1px solid #d8e2df } article p { margin: 12px 0 }')
  await fixture.put('src/Target.vue', `<script lang="ts">
    import {h, inject, ref, resolveComponent} from 'vue'
    import {theme} from 'ant-design-vue'
    export const NamedPage = {
      name:'OriginalNamedPage',
      setup() {
        const count = ref(0)
        const dialog = ref(false)
        const binding = inject('sample-binding')
        const tokens = theme.useToken()
        const label: string = 'Original named Ant Design Vue page'
        const Button = resolveComponent('AButton')
        const Modal = resolveComponent('AModal')
        return () => h('article', [h('h1',label),h('p',String(binding)),h('p','Theme token: '+tokens.token.value.colorPrimary),
          h(Button,{type:'primary',onClick:()=>count.value++},()=> 'Named counter: '+count.value),
          h(Button,{onClick:()=>dialog.value=true,style:{marginLeft:'12px'}},()=> 'Open library dialog'),
          h(Modal,{open:dialog.value,title:'Named preview dialog',onCancel:()=>dialog.value=false,onOk:()=>dialog.value=false},()=> 'Library dialog body'),
        ])
      },
    }
    export default {render() {throw new Error('WRONG_DEFAULT_TARGET_MOUNTED')}}
  </script>`)
  return { kind: 'file', path: 'src/Target.vue', exportName: 'NamedPage' } as const
}
