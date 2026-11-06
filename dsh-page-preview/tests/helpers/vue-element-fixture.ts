/** Element Plus 全量注册/原 Pinia 初始权限样本（方案 §6.9、§7.1、§15）；只借用显式现有包，不修改来源项目。 */
import { readFile, realpath, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ProjectConfig } from '../../src/shared/config/schema.ts'
import type { createVueViteFixture } from './vue-vite-fixture.ts'

export type ElementFixtureRole = 'viewer' | 'editor' | 'denied'

export async function prepareElementFixture(fixture: Pick<Awaited<ReturnType<typeof createVueViteFixture>>, 'appRoot' | 'put'>, project: ProjectConfig, modules: string, role: ElementFixtureRole) {
  for (const [name, version] of [['element-plus', '2.14.2'], ['pinia', '2.1.7']] as const) {
    const installed = await realpath(join(modules, name))
    const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as { version?: string }
    if (metadata.version !== version) throw new Error('Own sample requires its explicit installed library version')
    await symlink(installed, join(fixture.appRoot, 'node_modules', name))
  }
  project.runtime.dependencyRoots = [relative(fixture.appRoot, await realpath(modules))]
  project.runtime.setup = 'reviewed-setup.js'
  project.runtime.styles = ['node_modules/element-plus/dist/index.css', 'theme.css']
  project.scenarios = { own: { identity: { id: 'sample-' + role }, permissions: role === 'denied' ? [] : role === 'editor' ? ['orders:read', 'orders:edit'] : ['orders:read'], state: { title: 'Original Pinia order' } } }
  await fixture.put('package.json', JSON.stringify({ private: true, type: 'module', dependencies: { vue: '3.4.27', vite: '5.2.12', '@vitejs/plugin-vue': '5.1.4', 'element-plus': '2.14.2', pinia: '2.1.7' } }))
  await fixture.put('src/main.js', `import {createApp} from 'vue'; import Target from './Target.vue'; import ElementPlus from 'element-plus'; import 'element-plus/dist/index.css'; createApp(Target).use(ElementPlus).mount('#app')`)
  await fixture.put('src/permissions.js', `export function canRead(account) {return account.permissions.includes('orders:read')}
    export function canEdit(account) {return canRead(account) && account.permissions.includes('orders:edit')}
    export function permissionMode(account) {return !canRead(account) ? 'denied' : canEdit(account) ? 'editable' : 'read only'}`)
  await fixture.put('src/account.js', `import {defineStore} from 'pinia'
    export const useAccount = defineStore('original-account', {state:()=>({id:'not-initialized',permissions:[],title:'not-initialized',count:0}),actions:{editOrder(){this.count++}}})`)
  await fixture.put('reviewed-setup.js', `import {h} from 'vue'
    import ElementPlus, {ElConfigProvider} from 'element-plus'
    import zhCn from 'element-plus/es/locale/lang/zh-cn.mjs'
    import {createPinia} from 'pinia'
    import {useAccount} from './src/account.js'
    export default {
      install({app}) {const pinia=createPinia(); app.use(pinia); app.use(ElementPlus); return {pinia}},
      createContext({installation}) {return {...installation,wrap:{setup(_, {slots}) {return () => h(ElConfigProvider,{locale:zhCn,size:'small'},slots)}}}},
      applyScenario({scenario,context}) {useAccount(context.pinia).$patch({id:scenario.identity.id,permissions:scenario.permissions,title:scenario.state.title})},
    }`)
  await fixture.put('theme.css', ':root { --el-color-primary: #7c3aed; --el-color-primary-light-3: #9b6af0 } body { font-family: sans-serif; margin: 24px } article { max-width: 560px; padding: 20px; border: 1px solid #e1d8ef } article p { margin: 12px 0 }')
  await fixture.put('src/Target.vue', `<script>
    import {h,ref,resolveComponent} from 'vue'
    import {useAccount} from './account.js'
    import {canRead,canEdit,permissionMode} from './permissions.js'
    export const OrdersPage = {name:'OriginalOrdersPage',setup() {
      const account=useAccount()
      const date=ref(null)
      const Button=resolveComponent('ElButton')
      const Input=resolveComponent('ElInput')
      const DatePicker=resolveComponent('ElDatePicker')
      return () => {
        const heading=[h('h1','Original Element Plus page'),h('p',account.id+' / Permission mode: '+permissionMode(account))]
        if (!canRead(account)) return h('article',[...heading,h('p','Access denied by original permission function')])
        return h('article',[...heading,h('p','Pinia count: '+account.count),
        h(Input,{modelValue:account.title,'onUpdate:modelValue':value=>account.title=value,readonly:!canEdit(account),'aria-label':'Order title'}),
        h(Button,{type:'primary',disabled:!canEdit(account),onClick:()=>account.editOrder(),style:{margin:'12px 0'}},()=> 'Edit order'),
        h('p','Choose sample date'),h(DatePicker,{modelValue:date.value,'onUpdate:modelValue':value=>date.value=value,type:'date',placeholder:'Choose sample date'}),
      ])
      }
    }}
    export default {render() {throw new Error('WRONG_DEFAULT_ORDER_PAGE')}}
  </script>`)
  return { kind: 'file', path: 'src/Target.vue', exportName: 'OrdersPage' } as const
}
