/**
 * React 的最小环境模块声明（方案 §4.3）：DSH ModuleLoader 在客户端运行时提供 react，
 * 与官方客户端包编译产物中的 `require("react")` 一致。接入官方 React 类型包后删除本文件。
 */
declare module 'react' {
  export type ReactNode = ReactElement | string | number | boolean | null | undefined | Iterable<ReactNode>
  export interface ReactElement { type: unknown; props: unknown; key: string | number | null }
  export type ComponentType<P = object> = (props: P) => ReactNode
  export function createElement<P extends object>(type: ComponentType<P> | string, props?: P | null, ...children: ReactNode[]): ReactElement
  export function useState<S>(initial: S | (() => S)): [S, (value: S | ((previous: S) => S)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}
