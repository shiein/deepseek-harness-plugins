# Vue 兼容样本工具链依赖

状态：六份清单已获批准并安装在 `tests/toolchains/<组合>/`，由 `scripts/install-toolchains.mjs` 幂等维护（`npm test` 的 `pretest` 自动补齐缺失项）。仍为 private package、独立 lock、ignore-scripts；不改插件根 package.json/lock，不进入发行 files，也不装入业务项目。

方案 §1.3、§6.9、§15 要求 Vue 2.6/2.7、Vue CLI、Tier 1 全量注册/按需引入、主题/语言等样本。这些清单覆盖 Vue 2.6/2.7 + Vue CLI 4/5、Vue 3 已验组合与 Vite 6 未验证组合；固定版本及 engines/peer 元数据已从官方公开 npm registry 核对（output/vue-toolchain-metadata.json）。

工具链仅在本插件自有 tests/toolchains/<组合>/ 使用，可丢弃应用通过显式依赖根借用。不装入业务项目，不修改业务清单/锁/源码，不升级 DSH，不调用模型或计费服务，不上传或发布。实际执行只在本地测试 Runner/浏览器中进行。Node 24.13.1 是当前实测运行时，其他版本不据 engines 元数据直接宣称兼容。

| 清单 | 固定直接依赖 | 用途 |
| --- | --- | --- |
| [vue26-cli.package.json](toolchains/vue26-cli.package.json) | @vue/cli-service 5.0.9、@vue/cli-plugin-babel 5.0.9、vue 2.6.14、vue-template-compiler 2.6.14、element-ui 2.15.14、babel-plugin-component 1.1.1、sass 1.69.7、sass-loader 13.3.3、vuex 3.6.2、vue-router 3.6.5 | Vue 2 JS/CLI、全量与按需注册、自定义主题、原 Store/路由绑定 |
| [vue27-cli.package.json](toolchains/vue27-cli.package.json) | @vue/cli-service 5.0.9、@vue/cli-plugin-babel 5.0.9、@vue/cli-plugin-typescript 5.0.9、vue 2.7.16、vue-template-compiler 2.7.16、ant-design-vue 1.7.8、babel-plugin-import 1.13.8、less 4.2.2、less-loader 11.1.4、typescript 5.9.3 | Vue 2.7 TS/CLI、原 Babel 按需配置、Less 主题；TS 复用已批准版本，无插件升级 |
| [vue3-resolvers.package.json](toolchains/vue3-resolvers.package.json) | vue 3.4.27、unplugin-vue-components 0.27.5 | 现有 Vue 3 精确版本的 resolver 按需引入；Element Plus/Ant Design Vue 等包仍借用已存在的显式依赖 |
| [vue26-cli4.package.json](toolchains/vue26-cli4.package.json) | @vue/cli-service 4.5.19、@vue/cli-plugin-babel 4.5.19、vue 2.6.14、vue-template-compiler 2.6.14、element-ui 2.15.14、babel-plugin-component 1.1.1、core-js 3.51.0 | Vue CLI 4（webpack-dev-server v3）路径样本 |
| [vue3-self-contained.package.json](toolchains/vue3-self-contained.package.json) | vue 3.4.27、vite 5.2.12、@vitejs/plugin-vue 5.1.4、element-plus 2.14.2、ant-design-vue 4.2.5、pinia 2.1.7、vue-router 4.3.2、unplugin-vue-components 0.27.5 | Vue 3 已验组合自包含副本，样本不借用宿主依赖 |
| [vue3-unverified-vite6.package.json](toolchains/vue3-unverified-vite6.package.json) | vue 3.5.42、vite 6.4.3、@vitejs/plugin-vue 6.0.9 | 未验证工具链样本，验收 unverified_toolchain 如实执行路径 |

这些工具链不进入插件发行 files；元数据存在不代表适配器/样本通过，不据安装提升 verified 或支持范围。不使用 --force/legacy-peer-deps 隐藏依赖冲突，出现实质版本变化先说明。TypeScript 插件的 cache-loader、resolver 的 Nuxt kit/Babel parser 等可选 peer 不额外手工安装；如果真实运行要求新增直接依赖，届时说明具体失败后再申请。

项目 AGENTS.md §9 要求“新增运行时依赖……先问用户”；上述安装不授权把清单装进任何业务项目或放宽执行指纹、网络、文件和所有权约束。
