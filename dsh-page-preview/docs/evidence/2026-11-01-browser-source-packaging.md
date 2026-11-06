# 浏览器源码跟踪修正

2026-11-01：发现原 .gitignore 的 browser/ 同时忽略根构建目录和 src/browser/，导致浏览器源码未进入本地 Git。构建脚本必须从 src/browser/ 复制，新的检出因而无法可靠重建。

将规则限定为 /browser/，将现有 5 个浏览器源文件纳入跟踪。没有改变它们当前的运行行为；Vue 文件仍是未完成骨架，保留 TODO。bootstrap 中配置为占位，不包含会话 nonce 或用户状态。

验证：5 个 JS 文件均通过 Node 24.13.1 语法检查；typecheck/build 退出 0，完整测试 241/241 通过（含当前工作区的入口重放测试）。此修正只保证构建输入进入 Git，不据此声明 Vue 功能完成。

提交 e969cc1 后，将 HEAD 的 git archive 解包到可丢弃临时目录，仅链接当前已安装 node_modules；独立 tsc 与 copy-browser 均通过，src/browser 与 browser 均包含 bootstrap.js/vue。临时目录已删除。
