/**
 * Business Flow Analyst — Client half.
 * Registers a global sidebar panel icon (sidebar.panellist) whose id selects
 * the matching `main` panel, then renders the analysis workspace there.
 *
 * The flow graph is a layered drawing (top-to-bottom, or left-to-right when that reads larger)
 * whose automatic zoom keeps node text legible and scrolls along the long axis when needed.
 * Clicking a node shows its details, including the database tables it reads or writes.
 * Analyses are saved by the Host in ~/.dsh/business-flow/history.json.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-business-flow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback, useRef } = React;

    const EN = {
      panelTitle: 'Flow Analyst',
      pageTitle: 'Business Flow Analyst',
      pickProject: 'Choose project…',
      rePick: 'Change…',
      noProject: 'No project selected',
      businessLabel: 'Business to analyze',
      businessHint: 'Describe the business in natural language, e.g. "会员下单支付的完整链路" or "invoice approval flow"',
      analyze: 'Analyze flow',
      analyzing: 'Analyzing…',
      pingOk: 'Model ready',
      pingNoModel: 'No default model configured',
      pingFail: 'Service check failed',
      legendEntry: 'Entry',
      legendProcess: 'Process',
      legendData: 'Data',
      legendPermission: 'Permission',
      legendExternal: 'External',
      nodePanel: 'Node',
      files: 'Files',
      requirement: 'Requirement',
      requirementHint: 'Describe what you want changed or added at this node…',
      draft: 'Generate prompt',
      drafting: 'Generating…',
      promptResult: 'Generated prompt',
      openSession: 'Open in new session',
      opening: 'Opening…',
      copyPrompt: 'Copy',
      copied: 'Copied',
      selectNode: 'Select a node to see its details and refine a requirement. Click empty space or press Esc to clear the selection.',
      deselect: 'Clear selection',
      emptyGraph: 'Pick a project directory and describe a business to draw its flow topology.',
      emptyHint: 'The configured model reads the project and drafts the graph; node details and prompts follow from there.',
      openFail: 'Could not open a session',
      modelLabel: 'model',
      edgeFlow: 'flow',
      edgeData: 'data',
      edgeAuth: 'auth',
      history: 'History',
      historyEmpty: 'No saved analyses yet',
      historyHint: 'Saved in ~/.dsh/business-flow/history.json, no limit.',
      historyCount: '{n} records · {p} projects',
      historySearch: 'Search business or project path…',
      historyLoading: 'Loading history…',
      historyNoMatch: 'No record matches',
      historyDeleteProject: 'Delete all records of this project',
      historySaveFail: 'History was not saved',
      openHistory: 'Open history ({n})',
      close: 'Close',
      cancel: 'Cancel',
      update: 'Update',
      updating: 'Updating…',
      updateHint: 'Re-analyze this project and business and update this history record',
      fullscreen: 'Full screen',
      exitFullscreen: 'Exit full screen',
      refineInPanel: 'Refine this node',
      confirmDelete: 'Delete',
      confirmDeleteTitle: 'Delete this record?',
      confirmDeleteBody: 'The saved flow "{name}" will be removed. This cannot be undone.',
      confirmDeleteProjectTitle: 'Delete all records of this project?',
      confirmDeleteProjectBody: '{n} saved flows of {name} will be removed. This cannot be undone.',
      confirmClearTitle: 'Clear all history?',
      confirmClearBody: 'All {n} saved flows will be removed. This cannot be undone.',

      historyClear: 'Clear all',
      historyDelete: 'Delete',
      nodes: 'nodes',
      edges: 'edges',
      viewSwitch: 'Topology view',
      viewAll: 'Overview',
      viewFlow: 'Call chain',
      viewData: 'Data',
      viewAuth: 'Access',
      viewExternal: 'External',
      viewAllHint: 'Every node and edge of the analysis',
      viewFlowHint: 'How a request travels: entries, steps and call edges',
      viewDataHint: 'Which steps read or write which stores and tables',
      viewAuthHint: 'Authorization boundaries and the steps they guard',
      viewExternalHint: 'Third-party services and the steps that call them',
      viewEmpty: 'Nothing of this kind in the current analysis',
      viewCount: '{n} nodes',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomFit: 'Fit to view',
      summary: 'Summary',
      relatedFiles: 'Related files',
      tables: 'Tables',
      tableCount: '{n} tables',
      tableRead: 'read',
      tableWrite: 'write',
      tableReadWrite: 'read/write',
      tableUnverified: 'Not found in the related files — inferred by the model, please verify',
      tableInferred: 'inferred',
      tableUnchecked: 'not checked',
      tableUncheckedHint: 'Too many related files to check them all, so this table may still exist in the code',
      tableFoundIn: 'Found in {file}',
      tableShared: '+{n} nodes',
      tableSharedHint: 'Highlight the {n} other nodes that use this table',
      tableFocusClear: 'Clear table highlight',
      tablesNone: 'No database table identified for this node',
      tablesMissing: 'This record predates table detection; press Update to re-analyze and list the tables',
      edgeLegendTitle: 'Edges',
      step1: 'Project',
      step2: 'Business',
      step3: 'Flow',
      step4: 'Refine',
    };
    const ZH = {
      panelTitle: '流程分析',
      pageTitle: '业务流程分析',
      pickProject: '选择项目目录…',
      rePick: '更换…',
      noProject: '未选择项目',
      businessLabel: '要分析的业务',
      businessHint: '用自然语言描述业务，例如「会员下单支付的完整链路」或「发票审批流程」',
      analyze: '分析业务流程',
      analyzing: '分析中…',
      pingOk: '模型可用',
      pingNoModel: '未配置默认模型',
      pingFail: '服务自检失败',
      legendEntry: '入口',
      legendProcess: '流程',
      legendData: '数据',
      legendPermission: '权限',
      legendExternal: '外部',
      nodePanel: '节点',
      files: '关联文件',
      requirement: '需求描述',
      requirementHint: '描述想在这个节点上改动或新增什么…',
      draft: '生成精准 prompt',
      drafting: '生成中…',
      promptResult: '生成的 prompt',
      openSession: '在项目中新建会话',
      opening: '打开中…',
      copyPrompt: '复制',
      copied: '已复制',
      selectNode: '点击节点查看详情并细化需求；点击空白处或按 Esc 取消选择。',
      deselect: '取消选择',
      emptyGraph: '选择项目目录并描述业务后，这里会展示它的流程拓扑。',
      emptyHint: '配置好的模型会读取项目并画出流程；选中节点后还能生成更精准的需求 prompt。',
      openFail: '无法打开会话',
      modelLabel: '模型',
      edgeFlow: '调用',
      edgeData: '数据',
      edgeAuth: '鉴权',
      history: '历史',
      historyEmpty: '还没有保存的分析',
      historyHint: '保存在 ~/.dsh/business-flow/history.json，不设上限。',
      historyCount: '{n} 条 · {p} 个项目',
      historySearch: '搜索业务或项目路径…',
      historyLoading: '正在读取历史…',
      historyNoMatch: '没有匹配的记录',
      historyDeleteProject: '删除该项目的全部记录',
      historySaveFail: '历史记录未保存',
      openHistory: '打开历史（{n}）',
      close: '关闭',
      cancel: '取消',
      update: '更新',
      updating: '更新中…',
      updateHint: '用当前项目与业务重新分析，并更新这条历史记录',
      fullscreen: '全屏',
      exitFullscreen: '退出全屏',
      refineInPanel: '细化这个节点',
      confirmDelete: '删除',
      confirmDeleteTitle: '删除这条记录？',
      confirmDeleteBody: '将删除已保存的流程「{name}」，删除后无法恢复。',
      confirmDeleteProjectTitle: '删除该项目的全部记录？',
      confirmDeleteProjectBody: '将删除 {name} 下的 {n} 条流程记录，删除后无法恢复。',
      confirmClearTitle: '清空全部历史？',
      confirmClearBody: '将删除全部 {n} 条流程记录，删除后无法恢复。',

      historyClear: '清空全部',
      historyDelete: '删除',
      nodes: '节点',
      edges: '连线',
      viewSwitch: '拓扑视图',
      viewAll: '全貌',
      viewFlow: '调用链',
      viewData: '数据',
      viewAuth: '权限',
      viewExternal: '外部',
      viewAllHint: '分析出的全部节点与连线',
      viewFlowHint: '请求怎么走：入口、业务步骤与调用连线',
      viewDataHint: '哪些步骤读写了哪些存储和表',
      viewAuthHint: '鉴权边界，以及受它约束的步骤',
      viewExternalHint: '第三方服务，以及调用它们的步骤',
      viewEmpty: '当前分析里没有这一类内容',
      viewCount: '{n} 个节点',
      zoomIn: '放大',
      zoomOut: '缩小',
      zoomFit: '适应画布',
      summary: '说明',
      relatedFiles: '关联文件',
      tables: '涉及的表',
      tableCount: '{n} 张表',
      tableRead: '读',
      tableWrite: '写',
      tableReadWrite: '读写',
      tableUnverified: '在关联文件中没有找到这个表名，属于模型推断，请核对',
      tableInferred: '推断',
      tableUnchecked: '未核对',
      tableUncheckedHint: '关联文件太多，没有全部检查，这张表仍可能存在于代码中',
      tableFoundIn: '出现在 {file}',
      tableShared: '+{n} 个节点',
      tableSharedHint: '在图中高亮另外 {n} 个涉及这张表的节点',
      tableFocusClear: '取消表高亮',
      tablesNone: '这个节点没有识别到直接读写的数据库表',
      tablesMissing: '这条记录生成时还没有表识别，点「更新」重新分析后即可看到涉及的表',
      edgeLegendTitle: '连线',
      step1: '项目',
      step2: '业务',
      step3: '流程',
      step4: '细化',
    };

    const KIND_COLOR = {
      entry: '#2f9e6e',
      process: '#2f6fed',
      data: '#b98000',
      permission: '#d64545',
      external: '#7a5af8',
    };
    const KIND_ORDER = ['entry', 'process', 'data', 'permission', 'external'];
    const EDGE_COLOR = { flow: '#8b949e', data: '#b98000', auth: '#d64545' };

    // Browser cache key of versions before the Host history file; only read to migrate it.
    const STORAGE_KEY = 'bizflow.history.v1';

    const ACCENT = 'var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #2f6fed))';
    const CSS = `
      .bf-page { --bf-accent: ${ACCENT}; position: relative; display: flex; flex-direction: column;
        height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box;
        background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2328);
        font-size: 13px; line-height: 1.45; font-family: inherit; -webkit-font-smoothing: antialiased; }
      .bf-page *, .bf-page *::before, .bf-page *::after { box-sizing: border-box; }
      .bf-head { position: relative; flex: none; display: flex; flex-wrap: nowrap; gap: 10px;
        align-items: center; min-height: 48px; padding: 8px 16px;
        border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      html[data-platform=darwin] .bf-head { min-height: max(48px, var(--dsh-frame-top-clearance, 0px));
        padding-left: max(16px, calc(var(--dsh-frame-leading-clearance, 0px) + 8px)); }
      .bf-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650;
        font-size: 14px; white-space: nowrap; flex: none; }
      .bf-brand-icon { width: 26px; height: 26px; border-radius: 8px; display: inline-flex;
        align-items: center; justify-content: center; color: var(--bf-accent);
        background: color-mix(in srgb, var(--bf-accent) 12%, transparent); }
      .bf-project { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .bf-chip { display: inline-block; max-width: 40ch; min-width: 0; padding: 3px 9px;
        border-radius: 999px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-layer-1, #fafbfc); color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-spacer { flex: 1; }
      .bf-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: transparent;
        color: var(--dsw-alias-label-primary, #1f2328); padding: 5px 11px; font-family: inherit;
        font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap;
        transition: border-color .12s, background .12s, opacity .12s; }
      .bf-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
      .bf-btn:focus-visible, .bf-zoom button:focus-visible, .bf-icon-btn:focus-visible, .bf-view:focus-visible {
        outline: 2px solid var(--bf-accent); outline-offset: 1px; }
      .bf-btn:disabled { opacity: .45; cursor: default; }
      .bf-btn-primary { background: var(--dsw-alias-button-primary-fill, #1f2328); border-color: transparent;
        color: var(--dsw-alias-label-primary-foreground, #fff); }
      .bf-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, #1f2328); }
      .bf-btn-ghost { border-color: transparent; color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-btn-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-btn-block { width: 100%; }
      .bf-btn-ask { align-self: stretch; padding: 0 18px; min-width: 116px; }
      .bf-badge { min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px;
        background: color-mix(in srgb, var(--bf-accent) 14%, transparent); color: var(--bf-accent);
        font-size: 10px; font-weight: 600; line-height: 16px; text-align: center; }
      .bf-status { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 24ch;
        font-size: 11px; color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
      .bf-status .bf-dot { background: var(--dsw-alias-state-success-primary, #2f9e6e); }
      .bf-status.is-nomodel { color: var(--dsw-alias-state-warn-primary, #9a6700); }
      .bf-status.is-nomodel .bf-dot { background: var(--dsw-alias-state-warn-primary, #d4a72c); }
      .bf-status.is-fail { color: var(--dsw-alias-state-error-primary, #cf222e); }
      .bf-status.is-fail .bf-dot { background: var(--dsw-alias-state-error-primary, #cf222e); }
      .bf-steps { display: flex; gap: 10px; align-items: center; font-size: 11px; flex: none;
        color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-step { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      .bf-step.on { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; }
      .bf-step i, .bf-empty-steps i { width: 16px; height: 16px; border-radius: 50%; font-style: normal;
        font-size: 10px; line-height: 16px; text-align: center; flex: none;
        color: var(--dsw-alias-label-secondary, #57606a); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); }
      .bf-step.on i, .bf-empty-steps li.on i { background: var(--bf-accent); color: #fff; }
      .bf-body { display: flex; flex: 1; min-height: 0; }
      .bf-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .bf-ask { flex: none; display: flex; gap: 10px; padding: 12px 16px 10px; align-items: stretch; }
      .bf-input { flex: 1; width: 100%; resize: none; min-height: 44px; max-height: 120px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        border-radius: 9px; background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fafbfc));
        color: var(--dsw-alias-label-primary, #1f2328);
        padding: 8px 11px; font-size: 13px; font-family: inherit; line-height: 1.5; }
      .bf-input:focus { outline: 2px solid color-mix(in srgb, var(--bf-accent) 30%, transparent);
        outline-offset: -1px; border-color: var(--bf-accent); }
      .bf-progress { flex: none; height: 2px; margin: -6px 16px 6px; border-radius: 2px; overflow: hidden;
        position: relative; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); }
      .bf-progress::after { content: ""; position: absolute; inset: 0; width: 32%;
        background: linear-gradient(90deg, transparent, var(--bf-accent), transparent);
        animation: bf-slide 1.1s ease-in-out infinite; }
      @keyframes bf-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
      .bf-toolbar { flex: none; display: flex; flex-wrap: nowrap; gap: 10px; align-items: center;
        padding: 2px 16px 8px; color: var(--dsw-alias-label-secondary, #57606a); font-size: 11px; min-width: 0; }
      .bf-graph-title { font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328);
        flex: 0 1 auto; min-width: 3em; max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-views { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-layer-1, #fafbfc); }
      .bf-view { height: 22px; padding: 0 8px; border: 0; border-radius: 6px; cursor: pointer; background: transparent;
        font: inherit; font-size: 11.5px; white-space: nowrap; color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-view:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-view.is-on { background: var(--dsw-alias-bg-base, #fff); color: var(--bf-accent); font-weight: 600;
        box-shadow: 0 0 0 1px var(--dsw-alias-border-l1, rgba(0,0,0,.08)), 0 1px 2px rgba(0,0,0,.08); }
      .bf-view:disabled { cursor: default; opacity: .4; }
      .bf-legend { display: flex; flex-wrap: nowrap; gap: 10px; align-items: center; flex: 0 1 auto; min-width: 0;
        overflow: hidden; }
      .bf-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; white-space: nowrap; }
      .bf-legend-col { flex-direction: column; align-items: stretch; gap: 6px; margin-top: 2px; }
      .bf-legend-row { display: flex; align-items: center; gap: 7px; font-size: 12px; }
      .bf-legend-count { margin-left: auto; font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-count { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-zoom { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 8px; flex: none;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-layer-1, #fafbfc); }
      .bf-zoom button { width: 24px; height: 22px; border-radius: 6px; cursor: pointer; border: 0;
        background: transparent; color: inherit; font-size: 13px; line-height: 1; }
      .bf-zoom button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
        color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-zoom span { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
      .bf-canvas { position: relative; flex: 1; min-height: 0; overflow: auto; margin: 0 16px 14px; padding: 12px;
        border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        background-color: var(--dsw-alias-bg-layer-1, #fafbfc);
        background-image: radial-gradient(color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b949e) 28%, transparent) 1px, transparent 1px);
        background-size: 18px 18px; }
      .bf-canvas.is-empty { display: flex; overflow: hidden; }
      .bf-canvas::-webkit-scrollbar { width: 8px; height: 8px; }
      .bf-canvas::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1, rgba(0,0,0,.18)); border-radius: 99px; }
      .bf-stage { position: relative; width: max-content; min-width: 100%; display: flex; justify-content: center; }
      .bf-svg { display: block; }
      .bf-empty { flex: 1; display: flex; flex-direction: column; gap: 10px; align-items: center;
        justify-content: center; text-align: center; color: var(--dsw-alias-label-secondary, #57606a); padding: 0 48px; }
      .bf-empty-icon { width: 48px; height: 48px; border-radius: 14px; display: inline-flex; align-items: center;
        justify-content: center; color: var(--bf-accent); background: color-mix(in srgb, var(--bf-accent) 10%, transparent); }
      .bf-empty-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-empty-hint { font-size: 12px; line-height: 1.6; max-width: 52ch; }
      .bf-empty-steps { list-style: none; margin: 6px 0 0; padding: 0; display: flex; gap: 18px; font-size: 11.5px; }
      .bf-empty-steps li { display: inline-flex; align-items: center; gap: 6px; }
      .bf-empty-steps li.on { color: var(--dsw-alias-label-primary, #1f2328); font-weight: 600; }
      .bf-side { width: 340px; flex: none; display: flex; flex-direction: column; gap: 10px; min-height: 0;
        padding: 12px 14px 14px; overflow-y: auto;
        border-left: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      .bf-card { flex: none; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        border-radius: 11px; background: var(--dsw-alias-bg-layer-1, #fafbfc);
        padding: 11px 12px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
      .bf-card-grow { flex: 1 1 auto; min-height: 160px; }
      .bf-node-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
      .bf-node-name { font-size: 14px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
      .bf-node-tools { display: inline-flex; align-items: center; gap: 4px; flex: none; }
      .bf-kind { display: inline-flex; align-items: center; flex: none; font-size: 10.5px; font-weight: 600;
        border-radius: 999px; padding: 2px 8px; color: #fff; }
      .bf-summary { color: var(--dsw-alias-label-secondary, #57606a); line-height: 1.6; font-size: 12px; }
      .bf-section-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-files { display: flex; flex-direction: column; gap: 3px; padding-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); max-height: 150px; overflow-y: auto; }
      .bf-file { display: block; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px; line-height: 1.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-icon-btn { border: 0; background: transparent; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
        color: var(--dsw-alias-label-secondary, #57606a); font-size: 15px; line-height: 1; }
      .bf-icon-btn:hover { color: var(--dsw-alias-label-primary, #1f2328); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
      .bf-error { flex: none; margin: 0 16px 8px; padding: 8px 11px; border-radius: 8px;
        font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; max-height: 84px; overflow-y: auto;
        color: var(--dsw-alias-state-error-primary, #cf222e);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 26%, transparent); }
      .bf-prompt-box { flex: 1 1 auto; min-height: 80px; overflow-y: auto; white-space: pre-wrap; font-size: 12px; line-height: 1.65;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 8px;
        background: var(--dsw-alias-bg-base, #fff); padding: 10px; }
      .bf-actions { display: flex; gap: 8px; }
      .bf-actions .bf-btn { flex: 1; }
      .bf-pop { position: absolute; top: calc(100% - 2px); right: 16px; z-index: 30;
        width: 360px; max-height: min(60vh, 520px); overflow: hidden; display: flex;
        flex-direction: column; border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #fff));
        box-shadow: 0 12px 32px rgba(0,0,0,.18); }
      .bf-pop-head { display: flex; align-items: center; gap: 8px;
        padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        font-size: 12px; font-weight: 600; }
      .bf-pop-list { overflow-y: auto; padding: 6px; }
      .bf-pop-empty { padding: 18px 12px; text-align: center; font-size: 11.5px;
        color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-pop-row { display: flex; gap: 8px; align-items: flex-start; padding: 8px 9px;
        border-radius: 8px; cursor: pointer; }
      .bf-pop-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
      .bf-pop-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .bf-pop-title { font-size: 12px; font-weight: 600; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap; }
      .bf-pop-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #57606a);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-pop-del { flex: none; border: none; background: transparent; cursor: pointer;
        color: var(--dsw-alias-label-secondary, #57606a); font-size: 14px; line-height: 1;
        padding: 2px 4px; border-radius: 5px; }
      .bf-pop-del:hover { color: var(--dsw-alias-state-error-primary, #cf222e);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 10%, transparent); }
      .bf-pop-foot { display: flex; justify-content: space-between; align-items: center;
        gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
        font-size: 10.5px; color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-btn-sm { padding: 3px 9px; font-size: 11.5px; border-radius: 7px; }
      .bf-btn.is-on { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-btn-danger { background: var(--dsw-alias-state-error-primary, #cf222e); border-color: transparent; color: #fff; }
      .bf-btn-danger:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-state-error-primary, #cf222e); }
      .bf-text-danger { color: var(--dsw-alias-state-error-primary, #cf222e); }
      .bf-icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; }
      .bf-icon-danger:hover { color: var(--dsw-alias-state-error-primary, #cf222e);
        background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #cf222e) 10%, transparent); }
      .bf-graph { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .bf-graph:fullscreen, .bf-graph.is-native { background: var(--dsw-alias-bg-base, #fff); padding-top: 12px; }
      .bf-page.is-max .bf-head, .bf-page.is-max .bf-ask, .bf-page.is-max .bf-progress { display: none; }
      .bf-page.is-max .bf-toolbar { padding-top: 12px; }
      .bf-float { position: absolute; right: 28px; bottom: 26px; width: 320px; max-height: 60%; overflow-y: auto; z-index: 5;
        display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #fff)); box-shadow: 0 12px 30px rgba(0,0,0,.18); }
      .bf-drawer { position: absolute; top: 48px; right: 0; bottom: 0; z-index: 40; width: min(520px, 92%);
        display: flex; flex-direction: column; border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #fff)); box-shadow: -12px 0 32px rgba(0,0,0,.14);
        animation: bf-drawer-in .16s ease-out; }
      html[data-platform=darwin] .bf-drawer { top: max(48px, var(--dsh-frame-top-clearance, 0px)); }
      @keyframes bf-drawer-in { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
      .bf-drawer-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
      .bf-drawer-title { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 650; }
      .bf-drawer-search { flex: none; display: flex; align-items: center; gap: 8px; margin: 0 16px 10px; padding: 0 10px; height: 32px;
        border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14));
        background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-1, #fafbfc)); color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-drawer-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 12.5px;
        color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-drawer-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; }
      .bf-drawer-list .bf-error { margin: 0 6px; }
      .bf-group { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 11px; overflow: hidden;
        background: var(--dsw-alias-bg-layer-1, #fafbfc); flex: none; }
      .bf-group.is-current { border-color: color-mix(in srgb, var(--bf-accent) 45%, transparent); }
      .bf-group-head { display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 4px; }
      .bf-group-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 6px; border: 0; border-radius: 8px;
        background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .bf-group-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
      .bf-chev { display: inline-flex; transition: transform .12s; color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-chev.is-open { transform: rotate(90deg); }
      .bf-group-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .bf-group-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-group-path { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, #8b949e); overflow: hidden; text-overflow: ellipsis;
        white-space: nowrap; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); }
      .bf-group-count { flex: none; min-width: 22px; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; text-align: center;
        background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); color: var(--dsw-alias-label-secondary, #57606a); }
      .bf-group-list { display: flex; flex-direction: column; padding: 0 6px 6px; gap: 2px; }
      .bf-hist-row { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 32px; border-radius: 8px; cursor: pointer; }
      .bf-hist-row:hover, .bf-hist-row:focus-visible { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); outline: none; }
      .bf-hist-row.is-active { background: color-mix(in srgb, var(--bf-accent) 10%, transparent); }
      .bf-hist-row .bf-icon-btn { opacity: 0; }
      .bf-hist-row:hover .bf-icon-btn, .bf-hist-row:focus-within .bf-icon-btn { opacity: 1; }
      .bf-hist-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .bf-hist-title { font-size: 12.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-hist-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b949e); font-variant-numeric: tabular-nums; }
      .bf-drawer-foot { flex: none; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 16px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); font-size: 11px; color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-overlay { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 24px;
        background: color-mix(in srgb, #000 32%, transparent); }
      .bf-dialog { width: min(420px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 18px 18px 14px; border-radius: 14px;
        border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #fff));
        box-shadow: 0 20px 50px rgba(0,0,0,.25); }
      .bf-dialog-title { font-size: 15px; font-weight: 650; }
      .bf-dialog-body { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #57606a); overflow-wrap: anywhere; }
      .bf-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .bf-legend-sep { width: 1px; height: 12px; flex: none; background: var(--dsw-alias-border-l2, rgba(0,0,0,.14)); }
      .bf-edge-label text { font-family: inherit; }
      .bf-section-count { margin-left: 6px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #8b949e); }
      .bf-tables { display: flex; flex-direction: column; gap: 6px; padding-top: 8px;
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      .bf-tables-note { padding-top: 8px; font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-tertiary, #8b949e);
        border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
      .bf-table { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); background: var(--dsw-alias-bg-base, #fff); }
      .bf-table.is-active { border-color: color-mix(in srgb, #b98000 55%, transparent);
        background: color-mix(in srgb, #b98000 7%, var(--dsw-alias-bg-base, #fff)); }
      .bf-table-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .bf-table-icon { display: inline-flex; flex: none; color: #b98000; }
      .bf-table-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px;
        color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-access { flex: none; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; line-height: 1.5; }
      .bf-access-read { color: #2f6fed; background: color-mix(in srgb, #2f6fed 12%, transparent); }
      .bf-access-write { color: #c4560d; background: color-mix(in srgb, #c4560d 12%, transparent); }
      .bf-access-readwrite { color: #7a5af8; background: color-mix(in srgb, #7a5af8 12%, transparent); }
      .bf-table-inferred { flex: none; padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 1.5; cursor: help;
        color: #9a6700; border: 1px dashed color-mix(in srgb, #b98000 60%, transparent); }
      .bf-table-share { flex: none; padding: 1px 6px; border: 0; border-radius: 6px; background: transparent; cursor: pointer;
        font: inherit; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #57606a); white-space: nowrap; }
      .bf-table-share:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
        color: var(--dsw-alias-label-primary, #1f2328); }
      .bf-table-share.is-on { color: #9a6700; background: color-mix(in srgb, #b98000 14%, transparent); }
      .bf-table-share:focus-visible { outline: 2px solid var(--bf-accent); outline-offset: 1px; }
      .bf-table-note { padding-left: 19px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #57606a); }
      @media (max-width: 1320px) { .bf-legend-edge { display: none; } }
      @media (max-width: 1180px) { .bf-steps { display: none; } .bf-side { width: 300px; } .bf-graph-title { max-width: 7em; } }
      @media (max-width: 900px) {
        .bf-status.is-ok, .bf-legend { display: none; }
        .bf-side { width: 260px; }
        .bf-chip { max-width: 22ch; }
      }
    `;

    async function api(path, options) {
      let response;
      try {
        response = await fetch(`/api/dsh-business-flow${path}`, {
          method: options?.method ?? 'GET',
          headers: { accept: 'application/json', ...(options?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          credentials: 'same-origin',
          cache: 'no-store',
          body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        throw new Error(error?.message ?? 'network request failed');
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
      }
      return payload;
    }

    // ------------------------------------------------------------------------------------------
    // History: the Host file (~/.dsh/business-flow/history.json) is the only source of truth. Entries
    // that older versions cached in this browser are uploaded once and the cache is dropped, so a
    // deleted record can never be resurrected from a stale cache.
    // ------------------------------------------------------------------------------------------

    function validEntry(entry) {
      return Boolean(entry && typeof entry.id === 'string'
        && typeof entry.projectPath === 'string'
        && entry.graph && Array.isArray(entry.graph.nodes));
    }

    function readLegacyHistory() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(validEntry) : [];
      } catch {
        return [];
      }
    }

    function dropLegacyHistory() {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* privacy mode: nothing cached anyway */
      }
    }

    function sortHistory(entries) {
      return [...entries].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    }

    function newEntryId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function folderName(path) {
      const parts = String(path || '').split(/[\\/]/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(path || '');
    }

    function formatWhen(epoch) {
      const date = new Date(epoch);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      const now = new Date();
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      if (date.toDateString() === now.toDateString()) return clock;
      const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      return date.getFullYear() === now.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}-${day} ${clock}`;
    }

    // ------------------------------------------------------------------------------------------
    // Layout — layered (Sugiyama-style) drawing:
    //  1. cycles are broken by reversing DFS back edges (for ranking only);
    //  2. ranks by longest path, then sources are pulled down next to their first successor so
    //     entry points do not float far above the step they start;
    //  3. edges spanning several ranks get virtual nodes, so long edges route around real nodes
    //     instead of cutting through them;
    //  4. order inside each rank: alternating down/up barycenter sweeps, keeping the ordering with
    //     the fewest crossings;
    //  5. coordinates: each node is pulled toward the mean of its neighbours while ranks keep their
    //     order and spacing (a few relaxation rounds), then the drawing is normalised.
    // ------------------------------------------------------------------------------------------

    const NODE_W = 212;
    const NODE_H = 70;
    const DUMMY = 18;

    function layoutGraph(nodes, edges, orientation = 'vertical') {
      const vertical = orientation === 'vertical';
      const ids = nodes.map((n) => n.id);
      const known = new Set(ids);
      const pairs = [];
      const seenPair = new Set();
      edges.forEach((e, index) => {
        if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) return;
        pairs.push({ index, from: e.from, to: e.to });
        seenPair.add(`${e.from}>${e.to}`);
      });

      // 1. break cycles
      const out = new Map(ids.map((id) => [id, []]));
      for (const p of pairs) out.get(p.from).push(p);
      const state = new Map();
      const reversed = new Set();
      const dfs = (id) => {
        state.set(id, 1);
        for (const p of out.get(id)) {
          const s = state.get(p.to);
          if (s === 1) reversed.add(p.index);
          else if (s === undefined) dfs(p.to);
        }
        state.set(id, 2);
      };
      for (const id of ids) if (!state.has(id)) dfs(id);
      const dag = pairs.map((p) => (reversed.has(p.index)
        ? { ...p, from: p.to, to: p.from, reversed: true }
        : { ...p, reversed: false }));

      // 2. ranks
      const preds = new Map(ids.map((id) => [id, []]));
      const succs = new Map(ids.map((id) => [id, []]));
      for (const p of dag) {
        preds.get(p.to).push(p.from);
        succs.get(p.from).push(p.to);
      }
      const rank = new Map();
      const rankOf = (id) => {
        if (rank.has(id)) return rank.get(id);
        rank.set(id, 0);
        const ps = preds.get(id);
        const value = ps.length === 0 ? 0 : Math.max(...ps.map(rankOf)) + 1;
        rank.set(id, value);
        return value;
      };
      ids.forEach(rankOf);
      for (let round = 0; round < 3; round += 1) {
        for (const id of ids) {
          if (preds.get(id).length > 0 || succs.get(id).length === 0) continue;
          const lowest = Math.min(...succs.get(id).map((s) => rank.get(s))) - 1;
          if (lowest > rank.get(id)) rank.set(id, lowest);
        }
      }
      const rankCount = Math.max(0, ...ids.map((id) => rank.get(id))) + 1;

      // 3. virtual nodes
      const size = new Map(ids.map((id) => [id, vertical ? NODE_W : NODE_H]));
      const layers = Array.from({ length: rankCount }, () => []);
      ids.forEach((id) => layers[rank.get(id)].push(id));
      const up = new Map(ids.map((id) => [id, []]));
      const down = new Map(ids.map((id) => [id, []]));
      const chains = new Map();
      let dummyCount = 0;
      for (const p of dag) {
        const r0 = rank.get(p.from);
        const r1 = rank.get(p.to);
        const chain = [p.from];
        for (let r = r0 + 1; r < r1; r += 1) {
          const dummy = `\u0000d${dummyCount += 1}`;
          size.set(dummy, DUMMY);
          rank.set(dummy, r);
          layers[r].push(dummy);
          up.set(dummy, []);
          down.set(dummy, []);
          chain.push(dummy);
        }
        chain.push(p.to);
        for (let i = 0; i < chain.length - 1; i += 1) {
          down.get(chain[i]).push(chain[i + 1]);
          up.get(chain[i + 1]).push(chain[i]);
        }
        chains.set(p.index, { chain, reversed: p.reversed });
      }

      // 4. ordering
      const order = new Map();
      const index = () => layers.forEach((layer) => layer.forEach((id, i) => order.set(id, i)));
      index();
      const crossings = () => {
        let total = 0;
        for (let r = 0; r < layers.length - 1; r += 1) {
          const segs = [];
          for (const id of layers[r]) for (const next of down.get(id)) segs.push([order.get(id), order.get(next)]);
          for (let i = 0; i < segs.length; i += 1) {
            for (let j = i + 1; j < segs.length; j += 1) {
              if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) total += 1;
            }
          }
        }
        return total;
      };
      const sweep = (r, neighbours) => {
        const layer = layers[r];
        const scored = layer.map((id, i) => {
          const ns = neighbours.get(id).map((n) => order.get(n)).sort((a, b) => a - b);
          if (ns.length === 0) return { id, key: i, i };
          const mid = Math.floor(ns.length / 2);
          const median = ns.length % 2 === 1 ? ns[mid] : (ns[mid - 1] + ns[mid]) / 2;
          return { id, key: median, i };
        });
        scored.sort((a, b) => (a.key - b.key) || (a.i - b.i));
        layers[r] = scored.map((item) => item.id);
        layers[r].forEach((id, i) => order.set(id, i));
      };
      let best = layers.map((layer) => [...layer]);
      let bestCross = crossings();
      for (let pass = 0; pass < 8 && bestCross > 0; pass += 1) {
        if (pass % 2 === 0) for (let r = 1; r < layers.length; r += 1) sweep(r, up);
        else for (let r = layers.length - 2; r >= 0; r -= 1) sweep(r, down);
        const c = crossings();
        if (c < bestCross) {
          bestCross = c;
          best = layers.map((layer) => [...layer]);
        }
      }
      best.forEach((layer, r) => { layers[r] = layer; });
      index();

      // 5. coordinates along the order axis
      const gap = vertical ? 36 : 26;
      const coord = new Map();
      for (const layer of layers) {
        let cursor = 0;
        for (const id of layer) {
          coord.set(id, cursor + size.get(id) / 2);
          cursor += size.get(id) + gap;
        }
      }
      const place = (layer, desired) => {
        // keep order + spacing while staying as close as possible to `desired` (two-sided pass)
        const n = layer.length;
        const left = new Array(n);
        const right = new Array(n);
        for (let i = 0; i < n; i += 1) {
          const want = desired[i];
          left[i] = i === 0 ? want
            : Math.max(want, left[i - 1] + (size.get(layer[i - 1]) + size.get(layer[i])) / 2 + gap);
        }
        for (let i = n - 1; i >= 0; i -= 1) {
          const want = desired[i];
          right[i] = i === n - 1 ? want
            : Math.min(want, right[i + 1] - (size.get(layer[i + 1]) + size.get(layer[i])) / 2 - gap);
        }
        for (let i = 0; i < n; i += 1) coord.set(layer[i], (left[i] + right[i]) / 2);
        // averaging can re-introduce overlaps; one forward fix keeps spacing exact
        for (let i = 1; i < n; i += 1) {
          const min = coord.get(layer[i - 1]) + (size.get(layer[i - 1]) + size.get(layer[i])) / 2 + gap;
          if (coord.get(layer[i]) < min) coord.set(layer[i], min);
        }
      };
      const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
      for (let round = 0; round < 6; round += 1) {
        const downward = round % 2 === 0;
        const range = downward
          ? layers.map((_, r) => r)
          : layers.map((_, r) => layers.length - 1 - r);
        for (const r of range) {
          const layer = layers[r];
          const desired = layer.map((id) => {
            const ns = [...(downward ? up.get(id) : down.get(id)), ...(round > 3 ? (downward ? down.get(id) : up.get(id)) : [])];
            return ns.length === 0 ? coord.get(id) : mean(ns.map((n) => coord.get(n)));
          });
          place(layer, desired);
        }
      }
      let minCoord = Infinity;
      let maxCoord = -Infinity;
      for (const [id, c] of coord) {
        minCoord = Math.min(minCoord, c - size.get(id) / 2);
        maxCoord = Math.max(maxCoord, c + size.get(id) / 2);
      }
      if (!Number.isFinite(minCoord)) { minCoord = 0; maxCoord = 0; }

      // map to x/y (top-left of real nodes, centre points for virtual ones)
      // rank gaps leave room for one row of edge labels between layers
      const rankStep = vertical ? NODE_H + 74 : NODE_W + 104;
      const centre = (id) => {
        const o = coord.get(id) - minCoord;
        const rr = rank.get(id) * rankStep + (vertical ? NODE_H / 2 : NODE_W / 2);
        return vertical ? { x: o, y: rr } : { x: rr, y: o };
      };
      const pos = new Map();
      for (const id of ids) {
        const c = centre(id);
        pos.set(id, { x: c.x - NODE_W / 2, y: c.y - NODE_H / 2 });
      }
      const routes = new Map();
      for (const [edgeIndex, { chain, reversed: flipped }] of chains) {
        const points = chain.slice(1, -1).map(centre);
        routes.set(edgeIndex, flipped ? points.reverse() : points);
      }
      const span = maxCoord - minCoord;
      const depth = (rankCount - 1) * rankStep + (vertical ? NODE_H : NODE_W);
      return {
        pos,
        routes,
        width: (vertical ? span : depth) + 16,
        height: (vertical ? depth : span) + 16,
        NODE_W,
        NODE_H,
        orientation,
        crossings: bestCross,
      };
    }

    /** Scale at which a layout fits the canvas (both axes, never above 1). */
    function fitScale(layout, size) {
      if (!layout || !size || size.width <= 0 || size.height <= 0) return 1;
      return Math.min(1, (size.width - 32) / layout.width, (size.height - 24) / layout.height);
    }

    /** Below this scale node text gets too small to read, so the automatic fit stops shrinking. */
    const READABLE_SCALE = 0.8;
    const MIN_SCALE = 0.3;

    /**
     * Automatic zoom: the whole graph when it fits at a readable size; otherwise fit the width
     * (never above READABLE_SCALE) and let the canvas scroll along the long axis.
     */
    function readableScale(layout, size) {
      const all = fitScale(layout, size);
      if (all >= READABLE_SCALE || !layout || !size || size.width <= 0) return all;
      const widthFit = Math.min(1, (size.width - 32) / layout.width);
      return Math.max(all, Math.min(widthFit, READABLE_SCALE));
    }

    /** Pick the orientation that reads largest in the current canvas (ties keep top-to-bottom). */
    function pickLayout(graph, size) {
      const vertical = layoutGraph(graph.nodes, graph.edges, 'vertical');
      if (!size || size.width <= 0 || size.height <= 0) return vertical;
      const horizontal = layoutGraph(graph.nodes, graph.edges, 'horizontal');
      return fitScale(horizontal, size) > fitScale(vertical, size) * 1.08 ? horizontal : vertical;
    }

    /** Rough rendered width of a string: CJK/full-width glyphs ≈ 1em, others ≈ 0.58em. */
    function fitText(text, fontSize, maxWidth) {
      const value = String(text ?? '');
      let width = 0;
      for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        width += (code >= 0x2e80 ? 1 : 0.58) * fontSize;
        if (width > maxWidth) return `${value.slice(0, Math.max(1, i - 1))}…`;
      }
      return value;
    }

    /** `/a/b/c/d/e` → `/a/…/d/e` so the project name (the tail) always stays readable. */
    function shortPath(value, max = 46) {
      if (typeof value !== 'string' || value.length <= max) return value;
      const parts = value.split(/[\\/]/).filter(Boolean);
      const tail = parts.slice(-2).join('/');
      const head = /^[A-Za-z]:/.test(value) ? parts[0] : '';
      return `${head}${head ? '\\' : '/'}…/${tail}`;
    }

    function kindLabel(kind, t) {
      return t(`legend${kind[0].toUpperCase()}${kind.slice(1)}`);
    }

    function PanelIcon({ size, active }) {
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true,
      },
        h('rect', { x: 7, y: 2.6, width: 10, height: 4.4, rx: 1.6 }),
        h('rect', { x: 7, y: 17, width: 10, height: 4.4, rx: 1.6 }),
        h('path', { d: 'M12 7v4.2 M7 14.2h10a2 2 0 0 0 2-2V12 M7 14.2a2 2 0 0 1-2-2V12' }),
        h('path', { d: 'M5 12v2.2 M19 12v2.2' }));
    }

    function Icon({ d, size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d }));
    }
    const ICON = {
      refresh: 'M13 7.4a5 5 0 1 0 .2 2 M13.2 3.6v3.9H9.3',
      fit: 'M6 2.5H2.5V6 M10 2.5h3.5V6 M6 13.5H2.5V10 M10 13.5h3.5V10 M5.5 5.5h5v5h-5z',
      expand: 'M9.5 2.5h4v4 M13.5 2.5 9 7 M6.5 13.5h-4v-4 M2.5 13.5 7 9',
      collapse: 'M13.5 6.5h-4v-4 M9.5 6.5l4-4 M2.5 9.5h4v4 M6.5 9.5l-4 4',
      history: 'M2.8 8a5.2 5.2 0 1 0 1.6-3.8 M2.6 2.8v2.6h2.6 M8 5.2V8l2 1.4',
      trash: 'M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.6 8.5h5.8l.6-8.5',
      folder: 'M2.5 4.5a1 1 0 0 1 1-1h3l1.3 1.5h4.7a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
      chevron: 'M6 4l4 4-4 4',
      search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M10.6 10.6 14 14',
    };

    const KIND_GLYPH = {
      entry: 'M2.5 8h6.5 M6.5 5.3 9.2 8l-2.7 2.7 M10.5 3.2h1.8a1.2 1.2 0 0 1 1.2 1.2v7.2a1.2 1.2 0 0 1-1.2 1.2h-1.8',
      process: 'M3.5 3h9v3.6h-9z M3.5 9.4h9V13h-9z M8 6.6v2.8',
      data: 'M3 4.2c0-.9 2.2-1.6 5-1.6s5 .7 5 1.6v7.6c0 .9-2.2 1.6-5 1.6s-5-.7-5-1.6z'
        + ' M3 4.2c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6 M3 8c0 .9 2.2 1.6 5 1.6s5-.7 5-1.6',
      permission: 'M8 2.2l4.6 1.7v3.5c0 2.9-1.9 5.1-4.6 6.1-2.7-1-4.6-3.2-4.6-6.1V3.9z M6 7.9l1.4 1.4 2.7-2.7',
      external: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M2.5 8h11'
        + ' M8 2.5c1.5 1.5 2.3 3.4 2.3 5.5S9.5 12 8 13.5 M8 2.5C6.5 4 5.7 5.9 5.7 8s.8 4 2.3 5.5',
    };
    const TABLE_GLYPH = 'M2.5 3.5h11v9h-11z M2.5 6.6h11 M6.6 6.6v5.9';

    function tablesOf(node) {
      return Array.isArray(node?.tables)
        ? node.tables.filter((table) => table && typeof table.name === 'string' && table.name !== '')
        : [];
    }

    /** Lower-cased table name → ids of the nodes that touch it. */
    /**
     * Topology views derived from the one analysis (no extra model call). A view keeps its core
     * node kinds, the edges of its kinds, and both endpoints of every kept edge — so the access
     * view also shows the steps a permission guards and the external view shows who calls out.
     */
    const VIEWS = [
      { id: 'all' },
      { id: 'flow', coreKinds: ['entry', 'process'], edgeKinds: ['flow'] },
      { id: 'data', coreKinds: ['data'], edgeKinds: ['data'], withTables: true },
      { id: 'auth', coreKinds: ['permission'], edgeKinds: ['auth'] },
      { id: 'external', coreKinds: ['external'], touchingCore: true },
    ];

    /** @returns {{nodes: any[], edges: any[]}} the subgraph a view shows (the graph itself for `all`). */
    function deriveView(graph, viewId) {
      const view = VIEWS.find((item) => item.id === viewId);
      if (graph === null || view === undefined || view.id === 'all') return graph;
      const core = new Set(graph.nodes
        .filter((n) => view.coreKinds.includes(n.kind) || (view.withTables === true && tablesOf(n).length > 0))
        .map((n) => n.id));
      const edges = graph.edges.filter((e) => (view.touchingCore === true
        ? core.has(e.from) || core.has(e.to)
        : view.edgeKinds.includes(e.kind)));
      const keep = new Set(core);
      for (const e of edges) { keep.add(e.from); keep.add(e.to); }
      const nodes = graph.nodes.filter((n) => keep.has(n.id));
      const known = new Set(nodes.map((n) => n.id));
      return { ...graph, nodes, edges: edges.filter((e) => known.has(e.from) && known.has(e.to)) };
    }

    function tableUsage(graph) {
      const usage = new Map();
      for (const node of graph?.nodes ?? []) {
        for (const table of tablesOf(node)) {
          const key = table.name.toLowerCase();
          if (!usage.has(key)) usage.set(key, []);
          if (!usage.get(key).includes(node.id)) usage.get(key).push(node.id);
        }
      }
      return usage;
    }

    /** Rough rendered width of `text` (CJK/full-width glyphs ≈ 1em, others ≈ 0.58em). */
    function textWidth(text, fontSize) {
      let width = 0;
      for (const ch of String(text ?? '')) width += (ch.charCodeAt(0) >= 0x2e80 ? 1 : 0.58) * fontSize;
      return width;
    }

    /**
     * Edge end points spread along the node side they leave/enter, ordered by where the other
     * end lies, so fan-in and fan-out stay apart instead of meeting in one point.
     * Returns edge index → { from, to } anchor points.
     */
    function edgePorts(graph, layout) {
      const { pos, routes, NODE_W: W, NODE_H: H } = layout;
      const vertical = layout.orientation !== 'horizontal';
      const centre = (box) => ({ x: box.x + W / 2, y: box.y + H / 2 });
      const groups = new Map();
      const ends = new Map();
      const add = (edgeIndex, end, id, box, toward) => {
        const c = centre(box);
        const side = vertical ? (toward.y >= c.y ? 'b' : 't') : (toward.x >= c.x ? 'r' : 'l');
        const key = `${id}\u0000${side}`;
        if (!groups.has(key)) groups.set(key, { box, side, members: [] });
        groups.get(key).members.push({ edgeIndex, end, cross: vertical ? toward.x : toward.y });
      };
      graph.edges.forEach((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return;
        const via = routes.get(i) ?? [];
        add(i, 'from', e.from, a, via[0] ?? centre(b));
        add(i, 'to', e.to, b, via[via.length - 1] ?? centre(a));
      });
      for (const { box, side, members } of groups.values()) {
        members.sort((m, n) => m.cross - n.cross);
        const length = vertical ? W : H;
        const step = vertical ? 18 : 12;
        const span = Math.min(length * (vertical ? 0.72 : 0.6), (members.length - 1) * step);
        members.forEach((member, k) => {
          const offset = members.length === 1 ? 0 : -span / 2 + (k * span) / (members.length - 1);
          const point = vertical
            ? { x: box.x + W / 2 + offset, y: side === 'b' ? box.y + H : box.y }
            : { x: side === 'r' ? box.x + W : box.x, y: box.y + H / 2 + offset };
          if (!ends.has(member.edgeIndex)) ends.set(member.edgeIndex, {});
          ends.get(member.edgeIndex)[member.end] = point;
        });
      }
      return ends;
    }

    /** Control points of the cubic between `a` and `b`, tangent to the rank axis. */
    function segmentControls(a, b, vertical) {
      if (vertical) {
        const k = (b.y - a.y) / 2;
        return [{ x: a.x, y: a.y + k }, { x: b.x, y: b.y - k }];
      }
      const k = (b.x - a.x) / 2;
      return [{ x: a.x + k, y: a.y }, { x: b.x - k, y: b.y }];
    }

    /** Smooth path through `points` with tangents along the rank axis. */
    function smoothPath(points, vertical) {
      let d = `M${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i += 1) {
        const [c1, c2] = segmentControls(points[i - 1], points[i], vertical);
        d += ` C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${points[i].x} ${points[i].y}`;
      }
      return d;
    }

    /** Candidate label centres on the drawn curve, middle segment and middle of the curve first. */
    function labelCandidates(points, vertical) {
      const segments = [];
      for (let i = 1; i < points.length; i += 1) segments.push([points[i - 1], points[i]]);
      const middle = (segments.length - 1) / 2;
      const ordered = segments
        .map((segment, i) => ({ segment, i }))
        .sort((p, q) => Math.abs(p.i - middle) - Math.abs(q.i - middle));
      const out = [];
      for (const t of [0.5, 0.36, 0.64, 0.24, 0.76]) {
        for (const { segment: [a, b] } of ordered) {
          const [c1, c2] = segmentControls(a, b, vertical);
          const u = 1 - t;
          out.push({
            x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
            y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
          });
        }
      }
      return out;
    }

    function overlaps(r, list) {
      return list.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y);
    }

    function GraphView({ graph, layout, selectedId, onSelect, zoom, focusIds, t }) {
      const { pos, routes, NODE_W: W, NODE_H: H } = layout;
      const vertical = layout.orientation !== 'horizontal';
      const [hoverNode, setHoverNode] = useState(null);
      const [hoverEdge, setHoverEdge] = useState(null);
      const ports = useMemo(() => edgePorts(graph, layout), [graph, layout]);

      // What the drawing emphasises: a table highlight wins, then the selection, then the hover.
      const focusNode = selectedId ?? hoverNode;
      const lit = new Set();
      const litEdges = new Set();
      if (focusIds !== null && focusIds.length > 0) {
        for (const id of focusIds) lit.add(id);
        graph.edges.forEach((e, i) => { if (lit.has(e.from) && lit.has(e.to)) litEdges.add(i); });
      } else if (focusNode !== null) {
        lit.add(focusNode);
        graph.edges.forEach((e, i) => {
          if (e.from !== focusNode && e.to !== focusNode) return;
          litEdges.add(i);
          lit.add(e.from);
          lit.add(e.to);
        });
      }
      if (hoverEdge !== null && graph.edges[hoverEdge]) {
        litEdges.add(hoverEdge);
        lit.add(graph.edges[hoverEdge].from);
        lit.add(graph.edges[hoverEdge].to);
      }
      const emphasis = lit.size > 0 || litEdges.size > 0;

      const drawn = graph.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        const end = ports.get(i);
        if (!a || !b || !end?.from || !end?.to) return null;
        return { e, i, points: [end.from, ...(routes.get(i) ?? []), end.to] };
      });

      // Labels: emphasised edges first and always shown; the rest only where they fit without
      // covering a node or another label (the full text stays available as a tooltip).
      const blocked = [];
      for (const [, box] of pos) blocked.push({ x: box.x - 4, y: box.y - 3, w: W + 8, h: H + 6 });
      const labels = new Map();
      const order = drawn.filter(Boolean).sort((p, q) => Number(litEdges.has(q.i)) - Number(litEdges.has(p.i)));
      for (const item of order) {
        const text = item.e.label;
        if (text === '') continue;
        const forced = litEdges.has(item.i);
        if (emphasis && !forced) continue;
        const fontSize = 10;
        const width = Math.min(forced ? 190 : 150, textWidth(text, fontSize) + 14);
        const height = 17;
        let chosen = null;
        const candidates = labelCandidates(item.points, vertical);
        for (const c of candidates) {
          const rect = { x: c.x - width / 2, y: c.y - height / 2, w: width, h: height };
          if (!overlaps(rect, blocked)) { chosen = rect; break; }
        }
        if (chosen === null && forced) {
          const c = candidates[0];
          chosen = { x: c.x - width / 2, y: c.y - height / 2, w: width, h: height };
        }
        if (chosen === null) continue;
        blocked.push({ x: chosen.x - 3, y: chosen.y - 2, w: chosen.w + 6, h: chosen.h + 4 });
        labels.set(item.i, { rect: chosen, text: fitText(text, fontSize, width - 12), forced });
      }

      const edgeLayer = drawn.map((item) => {
        if (item === null) return null;
        const { e, i, points } = item;
        const kind = EDGE_COLOR[e.kind] ? e.kind : 'flow';
        const stroke = EDGE_COLOR[kind];
        const on = litEdges.has(i);
        const d = smoothPath(points, vertical);
        return h('g', {
          key: `e${i}`, className: 'bf-edge', opacity: emphasis && !on ? 0.16 : 1,
          onMouseEnter: () => setHoverEdge(i), onMouseLeave: () => setHoverEdge(null),
        },
          h('title', null, e.label === '' ? t(`edge${kind[0].toUpperCase()}${kind.slice(1)}`) : e.label),
          h('path', { d, fill: 'none', stroke: 'transparent', strokeWidth: 12 }),
          h('path', {
            d, fill: 'none', stroke, strokeWidth: on ? 2.2 : 1.4, strokeLinecap: 'round',
            markerEnd: `url(#bf-arrow-${kind})`, opacity: on ? 1 : 0.78,
            strokeDasharray: kind === 'auth' ? '5 4' : undefined,
          }));
      });

      const labelLayer = [...labels.entries()].map(([i, { rect, text, forced }]) => {
        const kind = EDGE_COLOR[graph.edges[i].kind] ? graph.edges[i].kind : 'flow';
        return h('g', { key: `l${i}`, className: 'bf-edge-label', pointerEvents: 'none' },
          h('rect', {
            x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: rect.h / 2,
            fill: 'var(--dsw-alias-bg-base, #fff)',
            stroke: EDGE_COLOR[kind], strokeOpacity: forced ? 0.7 : 0.32, strokeWidth: 1,
          }),
          h('text', {
            x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 + 3.5, fontSize: 10, textAnchor: 'middle',
            fill: forced ? 'var(--dsw-alias-label-primary, #1f2328)' : 'var(--dsw-alias-label-secondary, #57606a)',
          }, text));
      });

      const nodeLayer = graph.nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const kind = KIND_COLOR[n.kind] ? n.kind : 'process';
        const color = KIND_COLOR[kind];
        const selected = n.id === selectedId;
        const hovered = n.id === hoverNode;
        const focused = focusIds !== null && focusIds.includes(n.id);
        const dim = emphasis && !lit.has(n.id);
        const tableCount = tablesOf(n).length;
        const sub = n.summary === '' ? kindLabel(kind, t) : n.summary;
        return h('g', {
          key: n.id, className: 'bf-node', 'data-id': n.id,
          transform: `translate(${p.x},${p.y})`,
          opacity: dim ? 0.32 : 1,
          onClick: (event) => { event.stopPropagation(); onSelect(n.id); },
          onMouseEnter: () => setHoverNode(n.id),
          onMouseLeave: () => setHoverNode(null),
          style: { cursor: 'pointer' },
        },
          h('title', null, `${n.name}${n.summary ? `\n${n.summary}` : ''}`),
          selected || focused ? h('rect', {
            x: -4, y: -4, width: W + 8, height: H + 8, rx: 15, fill: 'none',
            stroke: selected ? ACCENT : KIND_COLOR.data, strokeOpacity: 0.28, strokeWidth: 4,
          }) : null,
          h('rect', {
            width: W, height: H, rx: 12,
            fill: 'var(--dsw-alias-bg-layer-2, #fff)',
            stroke: selected ? ACCENT : focused ? KIND_COLOR.data : hovered ? color
              : 'var(--dsw-alias-border-l2, rgba(0,0,0,.14))',
            strokeWidth: selected ? 2 : 1.2,
            filter: 'url(#bf-soft)',
          }),
          h('rect', { x: 12, y: 12, width: 24, height: 24, rx: 7, fill: color, fillOpacity: 0.13 }),
          h('path', {
            d: KIND_GLYPH[kind], transform: 'translate(16,16)', fill: 'none', stroke: color,
            strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
          }),
          h('text', {
            x: 46, y: 24, fontSize: 12.5, fontWeight: 600,
            fill: 'var(--dsw-alias-label-primary, #1f2328)',
          }, fitText(n.name, 12.5, W - 58)),
          h('text', {
            x: 46, y: 41, fontSize: 10.5,
            fill: 'var(--dsw-alias-label-secondary, #57606a)',
          }, fitText(sub, 10.5, W - 58)),
          h('text', { x: 46, y: 59, fontSize: 9.5, fontWeight: 600, fill: color }, kindLabel(kind, t)),
          tableCount === 0 ? null : h('g', { transform: `translate(${W - 12},0)` },
            h('title', null, t('tableCount', { n: tableCount })),
            h('path', {
              d: TABLE_GLYPH, transform: `translate(${-14 - textWidth(String(tableCount), 9.5) - 3},49) scale(.8)`,
              fill: 'none', stroke: KIND_COLOR.data, strokeWidth: 1.5, strokeLinejoin: 'round',
            }),
            h('text', {
              x: 0, y: 59, fontSize: 9.5, fontWeight: 600, textAnchor: 'end', fill: KIND_COLOR.data,
            }, String(tableCount))));
      });

      return h('svg', {
        className: 'bf-svg',
        width: layout.width * zoom,
        height: layout.height * zoom,
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        role: 'img',
        onClick: () => onSelect(null),
      },
        h('defs', null,
          Object.entries(EDGE_COLOR).map(([kind, color]) => h('marker', {
            key: kind, id: `bf-arrow-${kind}`, viewBox: '0 0 10 10', refX: 8.6, refY: 5,
            markerWidth: 7, markerHeight: 7, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
          }, h('path', { d: 'M0 1L9 5L0 9z', fill: color }))),
          h('filter', { id: 'bf-soft', x: '-20%', y: '-30%', width: '140%', height: '170%' },
            h('feDropShadow', { dx: 0, dy: 1, stdDeviation: 1.8, floodOpacity: 0.1 }))),
        h('g', { transform: 'translate(8,8)' }, edgeLayer, nodeLayer, labelLayer));
    }

    const ACCESS_KEY = { read: 'tableRead', write: 'tableWrite', readwrite: 'tableReadWrite' };

    /**
     * Tables a node reads or writes. `foundIn: null` marks a name the Host did not find in any
     * related file (model inference); `undefined` comes from records saved before the check.
     */
    function TablesSection({ node, usage, focusTable, setFocusTable, known, t }) {
      const tables = tablesOf(node);
      if (!known) return h('div', { className: 'bf-tables-note' }, t('tablesMissing'));
      if (tables.length === 0) {
        return node.kind === 'data' ? h('div', { className: 'bf-tables-note' }, t('tablesNone')) : null;
      }
      return h('div', { className: 'bf-tables' },
        h('div', { className: 'bf-section-label' }, t('tables'),
          h('span', { className: 'bf-section-count' }, String(tables.length))),
        tables.map((table) => {
          const key = table.name.toLowerCase();
          const others = (usage.get(key) ?? []).filter((id) => id !== node.id);
          const active = focusTable === key;
          const access = ACCESS_KEY[table.access];
          const inferred = table.foundIn === null;
          return h('div', { key, className: `bf-table${active ? ' is-active' : ''}` },
            h('div', { className: 'bf-table-row' },
              h('span', { className: 'bf-table-icon' }, h(Icon, { d: TABLE_GLYPH, size: 13 })),
              h('span', {
                className: 'bf-table-name',
                title: typeof table.foundIn === 'string' ? t('tableFoundIn', { file: table.foundIn }) : table.name,
              }, table.name),
              inferred ? h('span', {
                className: 'bf-table-inferred',
                title: t(table.unchecked ? 'tableUncheckedHint' : 'tableUnverified'),
              }, t(table.unchecked ? 'tableUnchecked' : 'tableInferred')) : null,
              access === undefined ? null : h('span', { className: `bf-access bf-access-${table.access}` }, t(access)),
              others.length === 0 ? null : h('button', {
                className: `bf-table-share${active ? ' is-on' : ''}`,
                title: active ? t('tableFocusClear') : t('tableSharedHint', { n: others.length }),
                'aria-pressed': active,
                onClick: (event) => { event.stopPropagation(); setFocusTable(active ? null : key); },
              }, t('tableShared', { n: others.length }))),
            table.note ? h('div', { className: 'bf-table-note' }, table.note) : null);
        }));
    }

    function ConfirmDialog({ title, body, confirmLabel, cancelLabel, busy, onConfirm, onCancel }) {
      const cancelRef = useRef(null);
      useEffect(() => {
        cancelRef.current?.focus?.();
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [onCancel]);
      return h('div', {
        className: 'bf-overlay',
        onClick: (event) => event.stopPropagation(),
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel(); },
      },
        h('div', { className: 'bf-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'bf-dialog-title' }, title),
          h('div', { className: 'bf-dialog-body' }, body),
          h('div', { className: 'bf-dialog-foot' },
            h('button', { className: 'bf-btn', ref: cancelRef, onClick: onCancel, disabled: busy }, cancelLabel),
            h('button', { className: 'bf-btn bf-btn-danger', onClick: onConfirm, disabled: busy }, confirmLabel))));
    }

    function HistoryDrawer({ entries, loading, error, currentId, currentProject, onPick, onAskDelete, onClose, t }) {
      const [query, setQuery] = useState('');
      const [collapsed, setCollapsed] = useState(() => new Set());
      const needle = query.trim().toLowerCase();
      const groups = useMemo(() => {
        const byPath = new Map();
        for (const entry of entries) {
          const text = `${entry.business || ''} ${entry.graph?.business || ''} ${entry.projectPath}`.toLowerCase();
          if (needle !== '' && !text.includes(needle)) continue;
          if (!byPath.has(entry.projectPath)) byPath.set(entry.projectPath, []);
          byPath.get(entry.projectPath).push(entry);
        }
        return [...byPath.entries()]
          .map(([path, list]) => ({ path, list: sortHistory(list), latest: Math.max(...list.map((e) => e.at ?? 0)) }))
          .sort((a, b) => (a.path === currentProject ? -1 : b.path === currentProject ? 1 : b.latest - a.latest));
      }, [entries, needle, currentProject]);
      const toggle = (path) => setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      return h('aside', { className: 'bf-drawer', role: 'dialog', 'aria-label': t('history'), onClick: (event) => event.stopPropagation() },
        h('div', { className: 'bf-drawer-head' },
          h('span', { className: 'bf-drawer-title' }, h(Icon, { d: ICON.history }), t('history')),
          h('span', { className: 'bf-count' }, t('historyCount', { n: entries.length, p: new Set(entries.map((e) => e.projectPath)).size })),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'bf-icon-btn', onClick: onClose, title: t('close'), 'aria-label': t('close') }, '×')),
        h('div', { className: 'bf-drawer-search' },
          h(Icon, { d: ICON.search, size: 13 }),
          h('input', {
            value: query, placeholder: t('historySearch'), 'aria-label': t('historySearch'),
            onChange: (event) => setQuery(event.target.value),
          })),
        h('div', { className: 'bf-drawer-list' },
          loading ? h('div', { className: 'bf-pop-empty' }, t('historyLoading')) : null,
          error ? h('div', { className: 'bf-error' }, error) : null,
          !loading && groups.length === 0
            ? h('div', { className: 'bf-pop-empty' }, entries.length === 0 ? t('historyEmpty') : t('historyNoMatch'))
            : null,
          groups.map((group) => {
            const isCollapsed = collapsed.has(group.path) && needle === '';
            return h('section', { key: group.path, className: `bf-group${group.path === currentProject ? ' is-current' : ''}` },
              h('div', { className: 'bf-group-head' },
                h('button', { className: 'bf-group-toggle', onClick: () => toggle(group.path), 'aria-expanded': !isCollapsed },
                  h('span', { className: `bf-chev${isCollapsed ? '' : ' is-open'}` }, h(Icon, { d: ICON.chevron, size: 12 })),
                  h(Icon, { d: ICON.folder, size: 14 }),
                  h('span', { className: 'bf-group-main' },
                    h('span', { className: 'bf-group-name' }, folderName(group.path)),
                    h('span', { className: 'bf-group-path', title: group.path }, group.path)),
                  h('span', { className: 'bf-group-count' }, String(group.list.length))),
                h('button', {
                  className: 'bf-icon-btn bf-icon-danger', title: t('historyDeleteProject'), 'aria-label': t('historyDeleteProject'),
                  onClick: () => onAskDelete({ kind: 'project', projectPath: group.path, count: group.list.length }),
                }, h(Icon, { d: ICON.trash, size: 13 }))),
              isCollapsed ? null : h('div', { className: 'bf-group-list' },
                group.list.map((entry) => h('div', {
                  key: entry.id,
                  className: `bf-hist-row${entry.id === currentId ? ' is-active' : ''}`,
                  role: 'button', tabIndex: 0,
                  onClick: () => onPick(entry),
                  onKeyDown: (event) => { if (event.key === 'Enter') onPick(entry); },
                },
                  h('div', { className: 'bf-hist-main' },
                    h('div', { className: 'bf-hist-title' }, entry.business || entry.graph.business || folderName(entry.projectPath)),
                    h('div', { className: 'bf-hist-meta' },
                      `${formatWhen(entry.at)} · ${entry.graph.nodes.length} ${t('nodes')} · ${entry.graph.edges.length} ${t('edges')}`)),
                  h('button', {
                    className: 'bf-icon-btn bf-icon-danger', title: t('historyDelete'), 'aria-label': t('historyDelete'),
                    onClick: (event) => { event.stopPropagation(); onAskDelete({ kind: 'entry', id: entry.id, title: entry.business || entry.graph.business }); },
                  }, h(Icon, { d: ICON.trash, size: 13 }))))));
          })),
        h('div', { className: 'bf-drawer-foot' },
          h('span', null, t('historyHint')),
          entries.length === 0 ? null : h('button', {
            className: 'bf-btn bf-btn-ghost bf-btn-sm bf-text-danger',
            onClick: () => onAskDelete({ kind: 'all', count: entries.length }),
          }, t('historyClear'))));
    }

    function Page(ctx, t) {
      return function BusinessFlowPage() {
        const [projectPath, setProjectPath] = useState('');
        const [business, setBusiness] = useState('');
        const [graph, setGraph] = useState(null);
        /** Project the graph on screen was drawn from; drafts and new sessions always use it. */
        const [graphProject, setGraphProject] = useState('');
        const [currentId, setCurrentId] = useState(null);
        const [selectedId, setSelectedId] = useState(null);
        const [requirement, setRequirement] = useState('');
        const [prompt, setPrompt] = useState('');
        const [busy, setBusy] = useState('');
        const [error, setError] = useState('');
        /** Model check: `ok` with the provider/model, `nomodel`, `fail`, or '' while unknown. */
        const [status, setStatus] = useState({ state: '', text: '' });
        const [copied, setCopied] = useState(false);
        const [history, setHistory] = useState([]);
        const [historyLoading, setHistoryLoading] = useState(true);
        const [historyError, setHistoryError] = useState('');
        const [historyOpen, setHistoryOpen] = useState(false);
        const [confirm, setConfirm] = useState(null);
        const [confirmBusy, setConfirmBusy] = useState(false);
        const [zoom, setZoom] = useState(1);
        const [zoomTouched, setZoomTouched] = useState(false);
        const [fullscreen, setFullscreen] = useState('');
        const [focusTable, setFocusTable] = useState(null);
        const [view, setView] = useState('all');
        const [, setLocaleTick] = useState(0);
        const canvasRef = useRef(null);
        const graphRef = useRef(null);
        /** The live Session of the graph on screen, so its prompt refinements continue there. */
        const analysisSession = useRef('');

        const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
        const selectedRef = useRef(selectedId);
        selectedRef.current = selectedId;
        const shownGraphRef = useRef(graph);
        shownGraphRef.current = graph;
        const views = useMemo(() => VIEWS.map((item) => {
          const sub = deriveView(graph, item.id);
          return { id: item.id, graph: sub, count: sub === null ? 0 : sub.nodes.length };
        }), [graph]);
        // A record without anything of the chosen kind falls back to the overview; the disabled
        // button shows why.
        const activeView = views.find((item) => item.id === view && item.count > 0) ?? views[0];
        const shown = activeView.graph;
        const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
        const sizeBucket = `${Math.round(canvasSize.width / 80)}x${Math.round(canvasSize.height / 80)}`;
        const layout = useMemo(
          () => (shown === null ? null : pickLayout(shown, canvasSize)),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [shown, sizeBucket],
        );

        const usage = useMemo(() => tableUsage(graph), [graph]);
        const shownIds = useMemo(() => new Set(shown?.nodes.map((n) => n.id) ?? []), [shown]);
        const focusIds = focusTable === null ? null : (usage.get(focusTable) ?? []).filter((id) => shownIds.has(id));

        const switchView = useCallback((next) => {
          setView(next);
          setZoomTouched(false);
          const sub = views.find((item) => item.id === next)?.graph;
          if (selectedId !== null && sub && !sub.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
        }, [views, selectedId]);
        // Records saved before table detection carry no `tables` field on any node.
        const tablesKnown = graph !== null && graph.nodes.some((n) => Array.isArray(n.tables));

        useEffect(() => {
          setRequirement('');
          setPrompt('');
          setFocusTable(null);
        }, [selectedId]);

        useEffect(() => { setFocusTable(null); }, [graph]);

        useEffect(() => {
          const onKey = (event) => {
            if (event.key !== 'Escape' || confirm !== null) return;
            if (historyOpen) setHistoryOpen(false);
            else if (fullscreen === 'page') setFullscreen('');
            else if (focusTable !== null) setFocusTable(null);
            else if (selectedId !== null) setSelectedId(null);
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [selectedId, historyOpen, fullscreen, confirm, focusTable]);

        const loadHistory = useCallback(async () => {
          setHistoryLoading(true);
          setHistoryError('');
          try {
            const value = await api('/history');
            let remote = Array.isArray(value.entries) ? value.entries.filter(validEntry) : [];
            const legacy = readLegacyHistory();
            const known = new Set(remote.map((entry) => entry.id));
            const missing = legacy.filter((entry) => !known.has(entry.id));
            if (missing.length > 0) {
              const merged = await api('/history/save', { method: 'POST', body: { entries: missing } });
              remote = Array.isArray(merged.entries) ? merged.entries.filter(validEntry) : remote;
            }
            if (legacy.length > 0) dropLegacyHistory();
            setHistory(sortHistory(remote));
          } catch (e) {
            setHistoryError(e.message);
          } finally {
            setHistoryLoading(false);
          }
        }, []);

        useEffect(() => { loadHistory(); }, [loadHistory]);

        useEffect(() => {
          const locale = ctx.get('locale');
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined;
          return locale.subscribe(() => setLocaleTick((value) => value + 1));
        }, []);

        useEffect(() => {
          let alive = true;
          api('/ping')
            .then((value) => {
              if (!alive) return;
              setStatus(value && value.configured
                ? { state: 'ok', text: `${value.provider}/${value.model}` }
                : { state: 'nomodel', text: t('pingNoModel') });
            })
            .catch((e) => { if (alive) setStatus({ state: 'fail', text: `${t('pingFail')}: ${e.message}` }); });
          return () => { alive = false; };
        }, []);

        useEffect(() => {
          if (!historyOpen) return undefined;
          const close = () => setHistoryOpen(false);
          const timer = window.setTimeout(() => window.addEventListener('click', close), 0);
          return () => {
            window.clearTimeout(timer);
            window.removeEventListener('click', close);
          };
        }, [historyOpen]);

        useEffect(() => {
          const el = canvasRef.current;
          if (el === null) return undefined;
          const measure = () => setCanvasSize((current) => (
            current.width === el.clientWidth && current.height === el.clientHeight
              ? current
              : { width: el.clientWidth, height: el.clientHeight }));
          measure();
          if (typeof ResizeObserver === 'undefined') return undefined;
          const observer = new ResizeObserver(measure);
          observer.observe(el);
          return () => observer.disconnect();
        }, [graph === null]);

        // Fit the whole graph into the visible canvas (both axes); a very large graph stops at 50%
        // and scrolls inside the canvas instead of shrinking into unreadable boxes.
        /** `readable` keeps text legible (may scroll); `all` shows the whole graph at once. */
        const applyFit = useCallback((mode = 'readable') => {
          if (layout === null) return;
          const raw = mode === 'all' ? fitScale(layout, canvasSize) : readableScale(layout, canvasSize);
          const next = Math.max(MIN_SCALE, Math.round(raw * 100) / 100);
          setZoom((current) => (current === next ? current : next));
          const el = canvasRef.current;
          if (el !== null) el.scrollTo?.({ left: 0, top: 0 });
        }, [layout, canvasSize]);

        useEffect(() => {
          if (!zoomTouched) applyFit();
        }, [applyFit, zoomTouched]);

        // Keep the selected node (or the nodes of a highlighted table) on screen: opening the side
        // panel narrows the canvas and re-fits the zoom, which would otherwise scroll it away.
        useEffect(() => {
          const ids = focusIds !== null && focusIds.length > 0 ? focusIds : selectedId !== null ? [selectedId] : [];
          const el = canvasRef.current;
          if (ids.length === 0 || el === null) return undefined;
          const frame = window.requestAnimationFrame(() => {
            const boxes = ids
              .map((id) => [...el.querySelectorAll('.bf-node')].find((node) => node.dataset.id === id))
              .filter(Boolean)
              .map((node) => node.getBoundingClientRect());
            if (boxes.length === 0) return;
            const view = el.getBoundingClientRect();
            const union = {
              left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)),
              top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)),
            };
            const pad = 16;
            const inside = union.left >= view.left + pad && union.right <= view.right - pad
              && union.top >= view.top + pad && union.bottom <= view.bottom - pad;
            if (inside) return;
            // Centre the group when it fits, otherwise bring its top-left corner into view.
            const fitsX = union.right - union.left <= view.width - 2 * pad;
            const fitsY = union.bottom - union.top <= view.height - 2 * pad;
            const dx = fitsX ? (union.left + union.right) / 2 - (view.left + view.right) / 2 : union.left - view.left - pad;
            const dy = fitsY ? (union.top + union.bottom) / 2 - (view.top + view.bottom) / 2 : union.top - view.top - pad;
            el.scrollBy?.({ left: dx, top: dy, behavior: 'smooth' });
          });
          return () => window.cancelAnimationFrame(frame);
        }, [selectedId, focusIds, zoom, layout]);

        // Browser fullscreen of the graph area, with an in-page maximise fallback.
        useEffect(() => {
          const onChange = () => {
            const active = document.fullscreenElement === graphRef.current && graphRef.current !== null;
            setFullscreen((current) => (active ? 'native' : current === 'native' ? '' : current));
            setZoomTouched(false);
          };
          document.addEventListener('fullscreenchange', onChange);
          return () => document.removeEventListener('fullscreenchange', onChange);
        }, []);

        const toggleFullscreen = useCallback(async () => {
          if (fullscreen === 'native') {
            try { await document.exitFullscreen?.(); } catch { setFullscreen(''); }
            return;
          }
          if (fullscreen === 'page') { setFullscreen(''); setZoomTouched(false); return; }
          const el = graphRef.current;
          try {
            if (el && typeof el.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
              await el.requestFullscreen();
              return;
            }
          } catch {
            /* refused by the shell: fall back to maximising inside the panel */
          }
          setFullscreen('page');
          setZoomTouched(false);
        }, [fullscreen]);

        const pick = useCallback(async () => {
          const ui = ctx.get('uiWorkspace');
          if (ui === undefined) { setError('uiWorkspace service unavailable'); return; }
          try {
            const path = await ui.pickDirectory();
            if (path) setProjectPath(path);
          } catch (e) { setError(e.message); }
        }, []);

        const remember = useCallback(async (entry) => {
          try {
            const value = await api('/history/upsert', { method: 'POST', body: { entry, replaceSameRun: true } });
            if (Array.isArray(value.entries)) setHistory(sortHistory(value.entries.filter(validEntry)));
          } catch (e) {
            // Shown on the page too: the drawer that also lists it is usually closed.
            const message = `${t('historySaveFail')}: ${e.message}`;
            setHistoryError(message);
            setError(message);
          }
        }, []);

        const runAnalysis = useCallback(async (path, text, keepId) => {
          setBusy(keepId ? 'update' : 'analyze');
          setError('');
          try {
            const value = await api('/analyze', { method: 'POST', body: { projectPath: path, business: text } });
            const nextGraph = value.graph ?? null;
            if (nextGraph === null) return;
            analysisSession.current = value.sessionId ?? '';
            const id = keepId || newEntryId();
            setGraph(nextGraph);
            setGraphProject(path);
            setCurrentId(id);
            setSelectedId(null);
            setPrompt('');
            setZoomTouched(false);
            await remember({ id, at: Date.now(), projectPath: path, business: text, graph: nextGraph });
          } catch (e) { setError(e.message); }
          finally { setBusy(''); }
        }, [remember]);

        const analyze = useCallback(() => runAnalysis(projectPath, business.trim(), null), [runAnalysis, projectPath, business]);
        const current = history.find((entry) => entry.id === currentId) ?? null;
        const update = useCallback(() => {
          if (current === null) return runAnalysis(projectPath, business.trim(), null);
          return runAnalysis(current.projectPath, current.business || business.trim(), current.id);
        }, [runAnalysis, current, projectPath, business]);

        const draft = useCallback(async () => {
          if (!selected) return;
          const nodeId = selected.id;
          const graphAtRequest = graph;
          setBusy('draft');
          setError('');
          try {
            const value = await api('/draft', {
              method: 'POST',
              body: { projectPath: graphProject, business: graph?.business || business, node: selected, graph, requirement, sessionId: analysisSession.current },
            });
            analysisSession.current = value.sessionId ?? '';
            // The user may have picked another node (or record) while the model was writing; the
            // prompt belongs to the node it was drafted for, so a late answer is dropped.
            if (selectedRef.current !== nodeId || shownGraphRef.current !== graphAtRequest) return;
            setPrompt(value.prompt);
          } catch (e) { setError(e.message); }
          finally { setBusy(''); }
        }, [graphProject, business, graph, selected, requirement]);

        const openSession = useCallback(async () => {
          setBusy('open');
          setError('');
          try {
            const workspaces = ctx.get('workspaces');
            const ui = ctx.get('uiWorkspace');
            if (workspaces === undefined || ui === undefined) throw new Error('workspace services unavailable');
            const view = await workspaces.create({ path: graphProject });
            const id = view && (view.id ?? view.workspaceId);
            if (id === undefined) throw new Error('workspace create returned no id');
            ui.startSession(id, { prompt, whenDraftExists: 'replace' });
            ctx.get('layout')?.selectPanel?.(null);
          } catch (e) { setError(`${t('openFail')}: ${e.message}`); }
          finally { setBusy(''); }
        }, [graphProject, prompt]);

        const copy = useCallback(async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch { /* clipboard unavailable */ }
        }, [prompt]);

        const loadRecord = useCallback((entry) => {
          analysisSession.current = '';
          setProjectPath(entry.projectPath);
          setBusiness(entry.business || entry.graph.business || '');
          setGraph(entry.graph);
          setGraphProject(entry.projectPath);
          setCurrentId(entry.id);
          setSelectedId(null);
          setRequirement('');
          setPrompt('');
          setError('');
          setZoomTouched(false);
          setHistoryOpen(false);
        }, []);

        const confirmDelete = useCallback(async () => {
          if (confirm === null) return;
          setConfirmBusy(true);
          try {
            const body = confirm.kind === 'entry' ? { ids: [confirm.id] }
              : confirm.kind === 'project' ? { projectPath: confirm.projectPath }
                : { all: true };
            const value = await api('/history/delete', { method: 'POST', body });
            setHistory(sortHistory((value.entries ?? []).filter(validEntry)));
            setConfirm(null);
          } catch (e) {
            setHistoryError(e.message);
            setConfirm(null);
          } finally {
            setConfirmBusy(false);
          }
        }, [confirm]);

        const analyzeDisabled = busy !== '' || projectPath === '' || business.trim() === '';
        const step = prompt !== '' ? 4 : graph !== null ? 3 : business.trim() !== '' ? 2 : 1;
        const maximised = fullscreen !== '';

        const nodeCard = selected === null ? null : [
          h('div', { key: 'head', className: 'bf-card' },
            h('div', { className: 'bf-node-head' },
              h('div', { className: 'bf-node-name' }, selected.name),
              h('span', { className: 'bf-node-tools' },
                h('span', { className: 'bf-kind', style: { background: KIND_COLOR[selected.kind] ?? KIND_COLOR.process } },
                  kindLabel(selected.kind, t)),
                h('button', {
                  className: 'bf-icon-btn', title: t('deselect'), 'aria-label': t('deselect'),
                  onClick: () => setSelectedId(null),
                }, '×'))),
            selected.summary === '' ? null : h('div', { className: 'bf-summary' }, selected.summary),
            h(TablesSection, { node: selected, usage, focusTable, setFocusTable, known: tablesKnown, t }),
            selected.files.length > 0 ? h('div', { className: 'bf-files' },
              h('div', { className: 'bf-section-label' }, t('relatedFiles')),
              selected.files.map((file, index) => h('span', { key: `${file}-${index}`, className: 'bf-file', title: file }, file)))
              : null),
        ];

        const sidePanel = selected === null || maximised ? null : h('aside', { className: 'bf-side' },
          nodeCard,
          h('div', { key: 'req', className: 'bf-card' },
            h('div', { className: 'bf-section-label' }, t('requirement')),
            h('textarea', {
              className: 'bf-input', rows: 3, value: requirement,
              placeholder: t('requirementHint'),
              onChange: (e) => setRequirement(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && busy === '' && requirement.trim() !== '') draft();
              },
            }),
            h('button', {
              className: 'bf-btn bf-btn-primary bf-btn-block', onClick: draft,
              disabled: busy !== '' || requirement.trim() === '',
            }, busy === 'draft' ? t('drafting') : t('draft'))),
          prompt === '' ? null : h('div', { key: 'prompt', className: 'bf-card bf-card-grow' },
            h('div', { className: 'bf-section-label' }, t('promptResult')),
            h('div', { className: 'bf-prompt-box' }, prompt),
            h('div', { className: 'bf-actions' },
              h('button', { className: 'bf-btn', onClick: copy }, copied ? t('copied') : t('copyPrompt')),
              h('button', {
                className: 'bf-btn bf-btn-primary', onClick: openSession, disabled: busy !== '',
              }, busy === 'open' ? t('opening') : t('openSession')))));

        const confirmSpec = confirm === null ? null
          : confirm.kind === 'entry'
            ? { title: t('confirmDeleteTitle'), body: t('confirmDeleteBody', { name: confirm.title || '—' }) }
            : confirm.kind === 'project'
              ? { title: t('confirmDeleteProjectTitle'), body: t('confirmDeleteProjectBody', { name: confirm.projectPath, n: confirm.count }) }
              : { title: t('confirmClearTitle'), body: t('confirmClearBody', { n: confirm.count }) };

        return h('div', { className: `bf-page${fullscreen === 'page' ? ' is-max' : ''}` },
          h('style', null, CSS),
          h('div', { className: 'bf-head', 'data-window-drag': true },
            h('span', { className: 'bf-brand' },
              h('span', { className: 'bf-brand-icon' }, h('svg', {
                viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none',
                stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round',
              },
                h('path', { d: 'M6 4v5a2 2 0 0 0 2 2h8a2 2 0 0 1 2 2v3' }),
                h('circle', { cx: 6, cy: 3.2, r: 1.6 }),
                h('circle', { cx: 18, cy: 19, r: 1.6 }))),
              t('pageTitle')),
            h('span', { className: 'bf-project' },
              h('span', { className: 'bf-chip', title: projectPath }, projectPath === '' ? t('noProject') : shortPath(projectPath)),
              h('button', { className: 'bf-btn bf-btn-ghost', onClick: pick }, projectPath === '' ? t('pickProject') : t('rePick'))),
            h('span', { className: 'bf-spacer' }),
            h('div', { className: 'bf-steps' },
              [t('step1'), t('step2'), t('step3'), t('step4')].map((label, index) => h('span', {
                key: label, className: `bf-step${step > index ? ' on' : ''}`,
              }, h('i', null, String(index + 1)), label))),
            status.state === '' ? null : h('span', {
              className: `bf-status is-${status.state}`, title: status.text, role: status.state === 'ok' ? undefined : 'status',
            },
              h('i', { className: 'bf-dot' }),
              h('span', { className: 'bf-status-text' }, status.text)),
            h('button', {
              className: `bf-btn bf-btn-ghost${historyOpen ? ' is-on' : ''}`,
              onClick: (event) => { event.stopPropagation(); setHistoryOpen((open) => !open); },
            }, h(Icon, { d: ICON.history }), t('history'), history.length > 0
              ? h('span', { className: 'bf-badge' }, history.length > 999 ? '999+' : String(history.length))
              : null)),
          h('div', { className: 'bf-body' },
            h('div', { className: 'bf-main' },
              h('div', { className: 'bf-ask' },
                h('textarea', {
                  className: 'bf-input', value: business, rows: 2,
                  placeholder: t('businessHint'),
                  onChange: (e) => setBusiness(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !analyzeDisabled) analyze();
                  },
                }),
                h('button', {
                  className: 'bf-btn bf-btn-primary bf-btn-ask', onClick: analyze, disabled: analyzeDisabled,
                }, busy === 'analyze' ? t('analyzing') : t('analyze'))),
              busy === 'analyze' || busy === 'update' ? h('div', { className: 'bf-progress' }) : null,
              error !== '' ? h('div', { className: 'bf-error' }, error) : null,
              h('div', { className: `bf-graph${fullscreen === 'native' ? ' is-native' : ''}`, ref: graphRef },
                graph !== null ? h('div', { className: 'bf-toolbar' },
                  h('div', { className: 'bf-views', role: 'tablist', 'aria-label': t('viewSwitch') },
                    views.map((item) => {
                      const label = t(`view${item.id[0].toUpperCase()}${item.id.slice(1)}`);
                      const empty = item.count === 0;
                      return h('button', {
                        key: item.id,
                        role: 'tab',
                        'aria-selected': item.id === activeView.id,
                        className: `bf-view${item.id === activeView.id ? ' is-on' : ''}`,
                        disabled: empty,
                        title: empty
                          ? t('viewEmpty')
                          : `${t(`view${item.id[0].toUpperCase()}${item.id.slice(1)}Hint`)} · ${t('viewCount', { n: item.count })}`,
                        onClick: () => switchView(item.id),
                      }, label);
                    })),
                  h('span', { className: 'bf-graph-title', title: graph.business || business }, graph.business || business),
                  h('span', { className: 'bf-count' },
                    `${shown.nodes.length} ${t('nodes')} · ${shown.edges.length} ${t('edges')}${current ? ` · ${formatWhen(current.at)}` : ''}`),
                  h('button', {
                    className: 'bf-btn bf-btn-sm', onClick: update, disabled: busy !== '' || (current === null && analyzeDisabled),
                    title: t('updateHint'),
                  }, h(Icon, { d: ICON.refresh, size: 13 }), busy === 'update' ? t('updating') : t('update')),
                  h('span', { style: { flex: 1 } }),
                  h('div', { className: 'bf-legend' },
                    KIND_ORDER.filter((kind) => shown.nodes.some((n) => n.kind === kind)).map((kind) => h('span', { key: kind, className: 'bf-legend-item' },
                      h('i', { className: 'bf-dot', style: { background: KIND_COLOR[kind] } }),
                      kindLabel(kind, t))),
                    h('span', { className: 'bf-legend-sep bf-legend-edge', 'aria-hidden': true }),
                    ['flow', 'data', 'auth'].filter((kind) => shown.edges.some((e) => e.kind === kind)).map((kind) => h('span', { key: kind, className: 'bf-legend-item bf-legend-edge' },
                      h('svg', { width: 18, height: 8, 'aria-hidden': true },
                        h('path', {
                          d: 'M1 4h16', stroke: EDGE_COLOR[kind], strokeWidth: 1.6, strokeLinecap: 'round',
                          strokeDasharray: kind === 'auth' ? '4 3' : undefined,
                        })),
                      t(`edge${kind[0].toUpperCase()}${kind.slice(1)}`)))),
                  h('div', { className: 'bf-zoom' },
                    h('button', {
                      title: t('zoomOut'), 'aria-label': t('zoomOut'),
                      onClick: () => { setZoomTouched(true); setZoom((z) => Math.max(0.3, Math.round((z - 0.1) * 100) / 100)); },
                    }, '−'),
                    h('span', null, `${Math.round(zoom * 100)}%`),
                    h('button', {
                      title: t('zoomIn'), 'aria-label': t('zoomIn'),
                      onClick: () => { setZoomTouched(true); setZoom((z) => Math.min(2, Math.round((z + 0.1) * 100) / 100)); },
                    }, '+'),
                    h('button', {
                      title: t('zoomFit'), 'aria-label': t('zoomFit'),
                      onClick: () => { setZoomTouched(true); applyFit('all'); },
                    }, h(Icon, { d: ICON.fit, size: 13 })),
                    h('button', {
                      title: maximised ? t('exitFullscreen') : t('fullscreen'),
                      'aria-label': maximised ? t('exitFullscreen') : t('fullscreen'),
                      onClick: toggleFullscreen,
                    }, h(Icon, { d: maximised ? ICON.collapse : ICON.expand, size: 13 })))) : null,
                h('div', {
                  className: `bf-canvas${graph === null ? ' is-empty' : ''}`,
                  ref: canvasRef,
                  onClick: (event) => { if (event.target === event.currentTarget) setSelectedId(null); },
                },
                  graph === null
                    ? h('div', { className: 'bf-empty' },
                      h('span', { className: 'bf-empty-icon' }, h('svg', {
                        viewBox: '0 0 24 24', width: 26, height: 26, fill: 'none',
                        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
                      },
                        h('rect', { x: 3, y: 3, width: 7, height: 5, rx: 1.6 }),
                        h('rect', { x: 14, y: 3, width: 7, height: 5, rx: 1.6 }),
                        h('rect', { x: 8.5, y: 16, width: 7, height: 5, rx: 1.6 }),
                        h('path', { d: 'M6.5 8v3.5h11V8 M12 11.5V16' }))),
                      h('div', { className: 'bf-empty-title' }, t('emptyGraph')),
                      h('div', { className: 'bf-empty-hint' }, t('emptyHint')),
                      h('ol', { className: 'bf-empty-steps' },
                        [t('step1'), t('step2'), t('step3'), t('step4')].map((label, index) => h('li', {
                          key: label, className: step > index ? 'on' : '',
                        }, h('i', null, String(index + 1)), label))),
                      history.length > 0 ? h('button', {
                        className: 'bf-btn', onClick: (event) => { event.stopPropagation(); setHistoryOpen(true); },
                      }, h(Icon, { d: ICON.history }), t('openHistory', { n: history.length })) : null)
                    : h('div', { className: 'bf-stage' },
                      h(GraphView, { graph: shown, layout, selectedId, zoom, focusIds, onSelect: setSelectedId, t }))),
                maximised && selected !== null
                  ? h('div', { className: 'bf-float' }, nodeCard,
                    h('button', {
                      className: 'bf-btn bf-btn-primary bf-btn-block',
                      onClick: () => { if (fullscreen === 'native') document.exitFullscreen?.(); setFullscreen(''); },
                    }, t('refineInPanel')))
                  : null)),
            sidePanel),
          historyOpen ? h(HistoryDrawer, {
            entries: history,
            loading: historyLoading,
            error: historyError,
            currentId,
            currentProject: projectPath,
            onPick: loadRecord,
            onAskDelete: setConfirm,
            onClose: () => setHistoryOpen(false),
            t,
          }) : null,
          confirmSpec === null ? null : h(ConfirmDialog, {
            title: confirmSpec.title,
            body: confirmSpec.body,
            confirmLabel: t('confirmDelete'),
            cancelLabel: t('cancel'),
            busy: confirmBusy,
            onConfirm: confirmDelete,
            onCancel: () => { if (!confirmBusy) setConfirm(null); },
          }));
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const localeOf = () => ctx.get('locale');
        // Resolve at call time: the panel follows a locale switch without re-applying.
        const fill = (text, values) => (values === undefined ? text
          : String(text).replace(/\{(\w+)\}/g, (all, name) => (values[name] === undefined ? all : String(values[name]))));
        const translate = (key, values) => fill(lookup(key), values);
        const lookup = (key) => {
          const locale = localeOf();
          if (locale === undefined) return EN[key] ?? key;
          const bound = locale.bind('business-flow');
          const value = bound(key);
          if (value !== key) return value;
          // The dictionary lookup fell through (unknown id or late registration):
          // fall back by the active language read straight from the snapshot.
          let active = '';
          try {
            active = locale.getLocale?.().active ?? '';
          } catch {
            /* snapshot unavailable */
          }
          const dict = /^zh/i.test(active) ? ZH : EN;
          return dict[key] ?? EN[key] ?? key;
        };
        const t = translate;
        const locale = localeOf();
        if (locale !== undefined) {
          ctx.effect(() => {
            const disposers = [];
            const add = (id, dict) => {
              if (typeof id !== 'string' || id === '') return;
              try {
                disposers.push(locale.register('business-flow', id, dict));
              } catch {
                /* already registered, or this build rejects the id */
              }
            };
            // The active id may be `zh`, `zh-CN`, `zh-Hans`, `zh-Hans-CN`, …; the
            // fallback chain otherwise walks straight to `en`, so register for
            // every locale the application declares plus the common tags.
            const declared = [];
            try {
              const snapshot = locale.getLocale?.();
              for (const entry of snapshot?.locales ?? []) {
                if (typeof entry?.id === 'string') declared.push(entry.id);
              }
            } catch {
              /* snapshot unavailable */
            }
            const ids = new Set(['en', 'zh', 'zh-CN', 'zh-Hans', 'zh-Hans-CN', ...declared]);
            for (const id of ids) {
              if (/^zh/i.test(id)) add(id, ZH);
              else if (/^en/i.test(id)) add(id, EN);
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* already removed */
                }
              }
            };
          }, 'business-flow locales');
        }


        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'business-flow', order: 60, label: () => t('panelTitle') },
            PanelIcon,
          ));

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'business-flow' }, Page(ctx, t)));
      },
    };
  },
});
