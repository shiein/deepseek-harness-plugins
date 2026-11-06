/**
 * 影响分析共用类型（方案 §5.2、§5.3；R3 计划 R3-4，见 docs/r3-plan.md）。
 *
 * 分工：core 只做"变更 → 项目 → 适配器边 → 候选排序"的编排与排序；具体技术（SFC、import、路由表、HTML 引用）
 * 只在适配器内部解析，按本文件的中立形状返回。core 对 adapters 只用 import type（AGENTS.md §6.3）。
 */

import type { Candidate, ChangeOrigin, TargetSelector } from '../../shared/contracts.ts'
import type { FileChange } from '../change/baseline.ts'

/** 一条"改动文件 → 可预览目标"的关系链；relation 自改动文件起、到目标止，供 Candidate.relation 直接使用。 */
export interface ImpactEdge {
  /** 相对应用根的改动文件。 */
  changed: string
  selector: TargetSelector
  /** 例如 ['src/styles/form.scss', 'src/components/UserForm.vue', 'route /settings']。 */
  relation: string[]
  /**
   * strong：改动文件就是目标，或经静态 import 链确定到达已登记/路由目标；
   * medium：经共享组件/样式到达多个页面中的一个；weak：只有目录/命名启发式。
   */
  evidence: Candidate['evidence']
  /** 页面级目标（路由页/登记目标）为 page；只是组件模块本身为 component。 */
  scope: 'page' | 'component'
}

/** 适配器对一组改动给出的边与缺口；不能构建依赖图时 manualOnly=true，不伪造候选。 */
export interface AdapterImpact {
  edges: ImpactEdge[]
  /** 无法静态确定的依赖（动态 import 表达式、运行时注册、未解析别名等），只写相对路径与原因。 */
  gaps: string[]
  /** 改动与本适配器的页面无关（后端、SQL、文档等），不应触发预览。 */
  unrelated: string[]
  manualOnly: boolean
}

/** 交给适配器的单个应用视图（Host 组装，避免 core 直接依赖 adapters/registry）。 */
export interface ImpactProject {
  projectId: string
  adapterId: string
  /** 绝对路径。 */
  appRoot: string
}

/** Host 注入的适配器调用；core 不 import adapters/registry。 */
export type AdapterImpactFn = (project: ImpactProject, changes: readonly FileChange[]) => Promise<AdapterImpact>

/** 一次分析的完整结果（§5.2）；candidates 已按证据排序并做代表页截断。 */
export interface ImpactResult {
  candidates: Candidate[]
  /** 被截断（未进入 candidates）的候选数量；完整列表经 detail 读取。 */
  omitted: number
  gaps: string[]
  /** 不属于任何已识别应用或与页面无关的改动；不触发预览。 */
  unrelated: string[]
  /** 本次分析用到的改动及来源标签，便于 Client/Agent 解释"为什么推荐它"。 */
  changes: Array<{ path: string; kind: FileChange['kind']; origin: ChangeOrigin }>
  /**
   * 已识别的应用（projectId → 工作区相对根；'' 表示应用根即工作区根）。
   * R3-5：Host 据此判定已有预览的项目是否受影响（执行项/构建配置变化可能不产生页面候选但仍在应用内）。
   */
  apps: Array<{ projectId: string; root: string }>
  /** 基线降级、预算耗尽等说明；为空表示完整分析。 */
  degraded: string[]
}
