// 受控样本入口；只调用浏览器运行时，不冒充公开适配器或网络 Mock。
import { startVuePreview } from './runtime/lifecycle.js'
window.fixtureEvents = []
var controller
async function start() {
  window.fixtureEvents = []
  controller = await startVuePreview({
    major: '3', el: document.getElementById('preview'), props: { label: 'original target' }, scenario: { role: 'reader' },
    beforeImport: async function () { window.fixtureEvents.push('prepare') },
    loadRuntime: async function () { window.fixtureEvents.push('runtime-import'); return import('./runtime/mount-vue3.js') },
    loadSetup: async function () { window.fixtureEvents.push('setup-import'); return import('./setup.js') },
    loadTarget: async function () { window.fixtureEvents.push('target-import'); return import('./Target.vue') },
    onMounted: function () {
      var events = window.fixtureEvents
      if (!(events.indexOf('prepare') < events.indexOf('runtime-import') && events.indexOf('install') < events.indexOf('context') && events.indexOf('scenario') < events.indexOf('target-import') && events.includes('root-mounted'))) throw new Error('Lifecycle order is incorrect')
      document.getElementById('state').textContent = 'Mounted: lifecycle order passed'
      window.__DSH_PREVIEW__.mounted(JSON.stringify({ sample: 'vue3-no-ui', events: events }))
    },
  })
}
document.getElementById('stop').addEventListener('click', async function () {
  await controller.stop()
  if (document.querySelector('[data-fixture-popup]')) throw new Error('Owned popup survived teardown')
  document.getElementById('state').textContent = 'Stopped: owned popup removed'
})
document.getElementById('restart').addEventListener('click', async function () { await controller.stop(); await start() })
start().catch(function (error) { throw error })
