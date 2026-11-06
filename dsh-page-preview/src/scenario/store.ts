/**
 * 按场景隔离、可重置的内存存储（方案 §7.2、§7.4）。
 * 插件只提供存储与重置；增删改语义由项目 handler 实现，插件不通用推导 CRUD。
 */

export class ScenarioStore {
  private data = new Map<string, unknown>()
  readonly scenario: string

  constructor(scenario: string) {
    this.scenario = scenario
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value)
  }

  delete(key: string): void {
    this.data.delete(key)
  }

  /** 场景切换时调用；默认重建上下文（§7.4），此处只负责插件自有数据。 */
  reset(): void {
    this.data = new Map()
  }
}
