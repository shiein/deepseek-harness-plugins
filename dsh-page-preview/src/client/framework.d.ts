/**
 * Client 运行时环境的最小编译期声明（方案 §4.3）。
 * DSH ModuleLoader 在客户端运行时提供 react/slots/locale，与官方包的 `require("react")` 相同；
 * 这里只声明本模块实际使用的 API 面。接入官方 @deepseek-ai/dsh-client-ui-slots、dsh-client-locale
 * 与 React 类型包后删除本文件与 react.d.ts。
 */

export {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-client-ui-slots 的宿主注册面：按位（seat）注册体或注入键控实现。 */
    slots: {
      inject(name: 'sidebar.right.pane.tab', provider: () => unknown): unknown
      register(descriptor: { name: 'sidebar.right.pane.tab'; key: string; locale?: string; inject?: (sessionId: string) => object }, body: unknown): () => void
    }
    /** dsh-client-locale 的文案命名空间绑定与注册。 */
    locale: {
      bind(namespace: string): (key: string) => string
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    }
  }
}
