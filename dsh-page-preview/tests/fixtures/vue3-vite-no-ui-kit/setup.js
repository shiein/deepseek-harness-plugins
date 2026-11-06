import { h } from 'vue'
export default {
  install: async function (args) {
    window.fixtureEvents.push('install')
    args.app.provide('installed', 'plugin-before-target')
    args.app.config.globalProperties.$fixture = 'global-property'
    args.app.component('fixture-label', { props: ['label'], render: function () { return h('strong', this.label) } })
    var popup = document.createElement('aside')
    popup.setAttribute('data-fixture-popup', 'owned')
    popup.textContent = 'Owned setup popup'
    document.body.appendChild(popup)
    return { id: {} }
  },
  createContext: async function (args) {
    window.fixtureEvents.push('context')
    if (!args.installation.id) throw new Error('Installation state missing')
    return {
      rootOptions: { provide: { rootValue: 'root-mixin' }, mounted: function () { window.fixtureEvents.push('root-mounted') } },
      wrap: { render: function () { return h('section', { 'data-provider': 'yes' }, this.$slots.default()) } },
    }
  },
  applyScenario: async function (args) { window.fixtureEvents.push('scenario'); window.fixtureRole = args.scenario.role },
  dispose: async function () { window.fixtureEvents.push('dispose') },
}
