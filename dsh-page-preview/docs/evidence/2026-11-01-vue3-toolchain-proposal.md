# Vue 3 自包含与未验证版本工具链依赖申请

状态：待用户批准；两份清单是 inert proposal，未安装、未改插件根 package.json/lock，也不被 npm workspaces 自动消费。

- `docs/development-progress.md` P1-3 要求测试不再借用外部项目的 `node_modules`：当前 27 项 Vue 集成测试靠 `DSH_PREVIEW_TEST_MODULES` 指向借用目录才能运行，本机无该目录时全部跳过。
- `docs/development-progress.md` P0-1 要求解除版本门禁：验收标准是"用一个非 3.4.27/5.2.12 的 Vue 3 + Vite 样本能打开预览，结果中带有未验证诊断"。这只差一个明确登记的非精确版本组合。
- 版本来源：官方公开 npm registry 元数据核对（`npm view`），所有版本发布日期均早于申请日 30 天以上。

批准后仅在本插件自有 `tests/toolchains/<组合>/` 安装，使用 private package、独立 lock 和 `--ignore-scripts`；测试 fixture 通过符号链接借用它们。不会装入业务项目，不修改业务清单/锁/源码，不升级 DSH，不调用模型或计费服务，不上传或发布。安装会下载官方公开包；实际执行只在本地测试 Runner/浏览器中进行。

| 清单 | 固定直接依赖 | 用途 |
| --- | --- | --- |
| [vue3-self-contained.package.json](toolchains/vue3-self-contained.package.json) | vue 3.4.27、vite 5.2.12、@vitejs/plugin-vue 5.1.4、element-plus 2.14.2、ant-design-vue 4.2.5、pinia 2.1.7、vue-router 4.3.2、unplugin-vue-components 0.27.5 | P1-3：替代借用的 `DSH_PREVIEW_TEST_MODULES`，让全部既有 Vue 3 集成测试（默认/命名 SFC、Element Plus/Pinia、Ant Design Vue、导航、网络边界、handler）在新克隆仓库中可复现；版本与已实测组合一致。unplugin-vue-components 已在已批准的 vue3-resolvers 清单中，并入本清单后可省掉一次单独安装 |
| [vue3-unverified-vite6.package.json](toolchains/vue3-unverified-vite6.package.json) | vue 3.5.42、vite 6.4.3、@vitejs/plugin-vue 6.0.9 | P0-1 验收：一个项目从未验证过的 Vue 3 + Vite 组合，用于证明"未验证照常执行并返回 `unverified_toolchain` 诊断"。不用于提升任何 verified 声明 |

这些工具链不进入插件发行 files；安装不提升 `verified` 或支持范围。依赖锁在用户批准且实际安装后生成；不使用 `--force`/`--legacy-peer-deps` 隐藏依赖冲突，出现实质版本变化先说明。如果真实运行要求新增直接依赖，届时说明具体失败后再申请。
