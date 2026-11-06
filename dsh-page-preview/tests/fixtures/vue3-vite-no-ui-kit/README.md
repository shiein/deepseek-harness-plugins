# Vue 3 browser lifecycle sample

Own disposable SFC + setup; no UI library or business project code. The former dev/vue-browser-probe.mjs (removed in R4-5; coverage now lives in tests/unit/vue-vite-public.test.mjs real-browser cases) copied this directory and src/browser/vue into an owned temporary root. Explicitly uses existing Vue/Vite/plugin-vue installation, configFile/envFile disabled, cache under the temporary root. It does not install dependencies or modify their owning project.

Checks app before install, scenario before target, props, registration/global property, rootOptions mixin/provide, Provider wrapper, owned body-popup cleanup and repeated mounting. Browser interactions also check SFC/CSS HMR and compile failure recovery. This is runtime-helper evidence, not product Adapter/Host/Mock acceptance; requirements are observation only.
