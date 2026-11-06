/** Vue 原内存路由/守卫样本（方案 §6.3、§6.6、§7.1）；自有文件，借用明确已有的 vue-router，不修改业务项目。 */
import { readFile, realpath, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ProjectConfig } from '../../src/shared/config/schema.ts'
import type { createVueViteFixture } from './vue-vite-fixture.ts'

export async function prepareNavigationFixture(fixture: Pick<Awaited<ReturnType<typeof createVueViteFixture>>, 'appRoot' | 'put'>, project: ProjectConfig, modules: string, denied = false) {
  const installed = await realpath(join(modules, 'vue-router'))
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')) as {version?: string}
  if (metadata.version !== '4.3.2') throw new Error('Own navigation sample requires its explicit installed router version')
  await symlink(installed, join(fixture.appRoot, 'node_modules/vue-router'))
  project.runtime.dependencyRoots = [relative(fixture.appRoot, await realpath(modules))]
  project.runtime.setup = 'reviewed-setup.js'
  project.runtime.styles = ['theme.css']
  project.scenarios = {own:{permissions:denied ? [] : ['orders:read'],route:{path:'/orders/:id#details',params:{id:'42'},query:{tab:'active',note:'from fixture'}}}}
  await fixture.put('src/permissions.js', `export function canReadOrders(permissions) {return permissions.includes('orders:read')}`)
  await fixture.put('src/router.js', `import {reactive,ref} from 'vue'
    import {createRouter,createMemoryHistory} from 'vue-router'
    import {canReadOrders} from './permissions.js'
    export const account=reactive({permissions:[]})
    export const guardCalls=ref(0)
    export function createProjectRouter() {
      const router=createRouter({history:createMemoryHistory(),routes:[
        {path:'/orders/:id',component:()=>import('./Target.vue'),meta:{requiresOrders:true}},
        {path:'/login',component:{template:'<p>Original login route</p>'}},
      ]})
      router.beforeEach(to=>{guardCalls.value++;return !to.meta.requiresOrders||canReadOrders(account.permissions) ? true : '/login'})
      return router
    }`)
  await fixture.put('src/OrderLayout.vue', `<template><section><header>Original order shell</header><slot /></section></template>`)
  await fixture.put('reviewed-setup.js', `import {createProjectRouter,account,guardCalls} from './src/router.js'
    import OrderLayout from './src/OrderLayout.vue'
    export default {
      install({app}) {const router=createProjectRouter();app.use(router);return {router}},
      createContext({installation}) {return {...installation,wrap:OrderLayout}},
      applyScenario({scenario}) {account.permissions=scenario.permissions},
      async navigate({href,context}) {
        await context.router.push(href);await context.router.isReady()
        const finalPath=context.router.currentRoute.value.fullPath
        if(finalPath!==href)document.getElementById('__dsh_preview_root').textContent='Original router redirected to: '+finalPath+'; guard calls: '+guardCalls.value
        return finalPath
      },
      dispose({installation}) {window.__ownRouteDisposed=true;window.__ownFinalRoute=installation.router.currentRoute.value.fullPath},
    }`)
  await fixture.put('src/Target.vue', `<script setup>
    import {ref,onMounted} from 'vue'
    import {useRoute} from 'vue-router'
    import {guardCalls} from './router.js'
    const route=useRoute()
    const count=ref(0)
    onMounted(()=>{window.__ownOrderMounted=true})
    </script><template><article><h1>Original routed order</h1><p>Order id: {{route.params.id}}</p><p>Query tab: {{route.query.tab}}</p><p>Query note: {{route.query.note}}</p><p>Route hash: {{route.hash}}</p><p>Route fullPath: {{route.fullPath}}</p><p>Route guard calls: {{guardCalls}}</p><button @click="count++">Routed counter: {{count}}</button></article></template>`)
  await fixture.put('theme.css', 'body { font-family: sans-serif; margin: 24px } header { border-bottom: 2px solid #286c50; padding: 16px 0 } article { padding: 16px 0 }')
}
