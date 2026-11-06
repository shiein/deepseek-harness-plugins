/**
 * Business Flow Analyst — Client half.
 * Registers a global sidebar panel icon (sidebar.panellist) whose id selects
 * the matching `main` panel, then renders the analysis workspace there.
 *
 * The flow graph is drawn top-to-bottom (vertical layers) and auto-fits the
 * panel width, so a wide flow stays readable without horizontal scrolling.
 * Successful analyses are kept in localStorage so earlier runs can be reopened.
 */
window.__ModuleLoader__.load({
  id: '@local/bizflow',
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
      historyHint: 'Saved in ~/.dsh/bizflow/history.json, no limit.',
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
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomFit: 'Fit to view',
      summary: 'Summary',
      relatedFiles: 'Related files',
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
      historyHint: '保存在 ~/.dsh/bizflow/history.json，不设上限。',
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
      zoomIn: '放大',
      zoomOut: '缩小',
      zoomFit: '适应画布',
      summary: '说明',
      relatedFiles: '关联文件',
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
      .bf-btn:focus-visible, .bf-zoom button:focus-visible, .bf-icon-btn:focus-visible {
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
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bf-legend { display: flex; flex-wrap: nowrap; gap: 10px; align-items: center; }
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
      @media (max-width: 1180px) { .bf-steps { display: none; } .bf-side { width: 300px; } }
      @media (max-width: 900px) {
        .bf-status, .bf-legend { display: none; }
        .bf-side { width: 260px; }
        .bf-chip { max-width: 22ch; }
      }
    `;

    async function api(path, options) {
      let response;
      try {
        response = await fetch(`/api/bizflow${path}`, {
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
    // History: the Host file (~/.dsh/bizflow/history.json) is the only source of truth. Entries
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

    const NODE_W = 198;
    const NODE_H = 64;
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
      const gap = vertical ? 30 : 22;
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
      const rankStep = vertical ? NODE_H + 58 : NODE_W + 76;
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
        width: (vertical ? span : depth) + 8,
        height: (vertical ? depth : span) + 8,
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

    /** Anchor point of a node box on the side facing `toward`. */
    function anchor(box, toward, w, hgt, vertical) {
      const cx = box.x + w / 2;
      const cy = box.y + hgt / 2;
      if (vertical) return { x: cx, y: toward.y >= cy ? box.y + hgt : box.y };
      return { x: toward.x >= cx ? box.x + w : box.x, y: cy };
    }

    /** Smooth path through `points` with tangents along the rank axis. */
    function smoothPath(points, vertical) {
      let d = `M${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        if (vertical) {
          const k = (b.y - a.y) / 2;
          d += ` C ${a.x} ${a.y + k}, ${b.x} ${b.y - k}, ${b.x} ${b.y}`;
        } else {
          const k = (b.x - a.x) / 2;
          d += ` C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
        }
      }
      return d;
    }

    function GraphView({ graph, layout, selectedId, onSelect, zoom, t }) {
      const { pos, routes, NODE_W: W, NODE_H: H } = layout;
      const vertical = layout.orientation !== 'horizontal';
      const related = new Set();
      if (selectedId !== null) {
        for (const e of graph.edges) {
          if (e.from === selectedId) related.add(e.to);
          if (e.to === selectedId) related.add(e.from);
        }
      }
      const edges = graph.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const via = routes.get(i) ?? [];
        const firstToward = via[0] ?? { x: b.x + W / 2, y: b.y + H / 2 };
        const lastFrom = via[via.length - 1] ?? { x: a.x + W / 2, y: a.y + H / 2 };
        const points = [anchor(a, firstToward, W, H, vertical), ...via, anchor(b, lastFrom, W, H, vertical)];
        const stroke = EDGE_COLOR[e.kind] ?? EDGE_COLOR.flow;
        const touches = selectedId !== null && (e.from === selectedId || e.to === selectedId);
        const dim = selectedId !== null && !touches;
        const mid = points.length >= 3
          ? points[Math.floor(points.length / 2)]
          : { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const labelWidth = Math.min(120, e.label.length * 5.6 + 8);
        return h('g', { key: `e${i}`, opacity: dim ? 0.22 : 1 },
          h('path', {
            d: smoothPath(points, vertical), fill: 'none', stroke, strokeWidth: touches ? 2 : 1.3,
            markerEnd: `url(#bf-arrow-${EDGE_COLOR[e.kind] ? e.kind : 'flow'})`, opacity: 0.9,
            strokeDasharray: e.kind === 'auth' ? '4 3' : undefined,
          }),
          e.label === '' ? null : h('g', null,
            h('rect', {
              x: mid.x - labelWidth / 2, y: mid.y - 7,
              width: labelWidth, height: 14, rx: 4,
              fill: 'var(--dsw-alias-bg-layer-1, #fafbfc)', opacity: 0.92,
            }),
            h('text', {
              x: mid.x, y: mid.y + 3, fontSize: 9.5, textAnchor: 'middle',
              fill: 'var(--dsw-alias-label-secondary, #57606a)',
            }, fitText(e.label, 9.5, labelWidth - 6))));
      });

      const nodes = graph.nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const color = KIND_COLOR[n.kind] ?? KIND_COLOR.process;
        const selected = n.id === selectedId;
        const dim = selectedId !== null && !selected && !related.has(n.id);
        const sub = n.summary === '' ? kindLabel(n.kind, t) : n.summary;
        return h('g', {
          key: n.id, className: 'bf-node',
          transform: `translate(${p.x},${p.y})`,
          opacity: dim ? 0.45 : 1,
          onClick: (event) => { event.stopPropagation(); onSelect(n.id); },
          style: { cursor: 'pointer' },
        },
          h('title', null, `${n.name}${n.summary ? `\n${n.summary}` : ''}`),
          h('rect', {
            width: W, height: H, rx: 10,
            fill: 'var(--dsw-alias-bg-layer-2, #fff)',
            stroke: selected ? ACCENT : color,
            strokeWidth: selected ? 2.4 : 1.2,
            filter: 'url(#bf-soft)',
          }),
          h('path', { d: `M0 10a10 10 0 0 1 10-10h1v${H}h-1A10 10 0 0 1 0 ${H - 10}z`, fill: color, opacity: 0.9 }),
          h('text', {
            x: 20, y: 24, fontSize: 12, fontWeight: 600,
            fill: 'var(--dsw-alias-label-primary, #1f2328)',
          }, fitText(n.name, 12, W - 34)),
          h('text', {
            x: 20, y: 42, fontSize: 10,
            fill: 'var(--dsw-alias-label-secondary, #57606a)',
          }, fitText(sub, 10, W - 32)),
          h('text', {
            x: W - 10, y: H - 8, fontSize: 9, textAnchor: 'end',
            fill: color, fontWeight: 600,
          }, kindLabel(n.kind, t)));
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
            key: kind, id: `bf-arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5,
            markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse',
          }, h('path', { d: 'M0 0L10 5L0 10z', fill: color }))),
          h('filter', { id: 'bf-soft', x: '-20%', y: '-30%', width: '140%', height: '170%' },
            h('feDropShadow', { dx: 0, dy: 1.5, stdDeviation: 1.6, floodOpacity: 0.13 }))),
        h('g', { transform: 'translate(4,4)' }, edges, nodes));
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
      return function BizflowPage() {
        const [projectPath, setProjectPath] = useState('');
        const [business, setBusiness] = useState('');
        const [graph, setGraph] = useState(null);
        const [currentId, setCurrentId] = useState(null);
        const [selectedId, setSelectedId] = useState(null);
        const [requirement, setRequirement] = useState('');
        const [prompt, setPrompt] = useState('');
        const [busy, setBusy] = useState('');
        const [error, setError] = useState('');
        const [status, setStatus] = useState('');
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
        const [, setLocaleTick] = useState(0);
        const canvasRef = useRef(null);
        const graphRef = useRef(null);

        const selected = graph?.nodes.find((n) => n.id === selectedId) ?? null;
        const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
        const sizeBucket = `${Math.round(canvasSize.width / 80)}x${Math.round(canvasSize.height / 80)}`;
        const layout = useMemo(
          () => (graph === null ? null : pickLayout(graph, canvasSize)),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [graph, sizeBucket],
        );

        useEffect(() => {
          setRequirement('');
          setPrompt('');
        }, [selectedId]);

        useEffect(() => {
          const onKey = (event) => {
            if (event.key !== 'Escape' || confirm !== null) return;
            if (historyOpen) setHistoryOpen(false);
            else if (fullscreen === 'page') setFullscreen('');
            else if (selectedId !== null) setSelectedId(null);
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [selectedId, historyOpen, fullscreen, confirm]);

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
              setStatus(value && value.configured ? `${value.provider}/${value.model}` : '');
            })
            .catch(() => { if (alive) setStatus(''); });
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
        const applyFit = useCallback(() => {
          if (layout === null) return;
          const next = Math.max(0.5, Math.round(fitScale(layout, canvasSize) * 100) / 100);
          setZoom((current) => (current === next ? current : next));
          const el = canvasRef.current;
          if (el !== null) el.scrollTo?.({ left: 0, top: 0 });
        }, [layout, canvasSize]);

        useEffect(() => {
          if (!zoomTouched) applyFit();
        }, [applyFit, zoomTouched]);

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
            setHistoryError(`${t('historySaveFail')}: ${e.message}`);
          }
        }, []);

        const runAnalysis = useCallback(async (path, text, keepId) => {
          setBusy(keepId ? 'update' : 'analyze');
          setError('');
          try {
            const value = await api('/analyze', { method: 'POST', body: { projectPath: path, business: text } });
            const nextGraph = value.graph ?? null;
            if (nextGraph === null) return;
            const id = keepId || newEntryId();
            setGraph(nextGraph);
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
          setBusy('draft');
          setError('');
          try {
            const value = await api('/draft', {
              method: 'POST',
              body: { projectPath, business: graph?.business || business, node: selected, graph, requirement },
            });
            setPrompt(value.prompt);
          } catch (e) { setError(e.message); }
          finally { setBusy(''); }
        }, [projectPath, business, graph, selected, requirement]);

        const openSession = useCallback(async () => {
          setBusy('open');
          setError('');
          try {
            const workspaces = ctx.get('workspaces');
            const ui = ctx.get('uiWorkspace');
            if (workspaces === undefined || ui === undefined) throw new Error('workspace services unavailable');
            const view = await workspaces.create({ path: projectPath });
            const id = view && (view.id ?? view.workspaceId);
            if (id === undefined) throw new Error('workspace create returned no id');
            ui.startSession(id, { prompt, whenDraftExists: 'replace' });
            ctx.get('layout')?.selectPanel?.(null);
          } catch (e) { setError(`${t('openFail')}: ${e.message}`); }
          finally { setBusy(''); }
        }, [projectPath, prompt]);

        const copy = useCallback(async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch { /* clipboard unavailable */ }
        }, [prompt]);

        const loadRecord = useCallback((entry) => {
          setProjectPath(entry.projectPath);
          setBusiness(entry.business || entry.graph.business || '');
          setGraph(entry.graph);
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
            status === '' ? null : h('span', { className: 'bf-status', title: status },
              h('i', { className: 'bf-dot', style: { background: '#2f9e6e' } }),
              h('span', { className: 'bf-status-text' }, status)),
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
                  h('span', { className: 'bf-graph-title', title: graph.business }, graph.business || business),
                  h('span', { className: 'bf-count' },
                    `${graph.nodes.length} ${t('nodes')} · ${graph.edges.length} ${t('edges')}${current ? ` · ${formatWhen(current.at)}` : ''}`),
                  h('button', {
                    className: 'bf-btn bf-btn-sm', onClick: update, disabled: busy !== '' || (current === null && analyzeDisabled),
                    title: t('updateHint'),
                  }, h(Icon, { d: ICON.refresh, size: 13 }), busy === 'update' ? t('updating') : t('update')),
                  h('span', { style: { flex: 1 } }),
                  h('div', { className: 'bf-legend' },
                    KIND_ORDER.map((kind) => h('span', { key: kind, className: 'bf-legend-item' },
                      h('i', { className: 'bf-dot', style: { background: KIND_COLOR[kind] } }),
                      kindLabel(kind, t)))),
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
                      onClick: () => { setZoomTouched(false); applyFit(); },
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
                      h(GraphView, { graph, layout, selectedId, zoom, onSelect: setSelectedId, t }))),
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
          const bound = locale.bind('bizflow');
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
                disposers.push(locale.register('bizflow', id, dict));
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
          }, 'bizflow locales');
        }


        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'bizflow', order: 60, label: () => t('panelTitle') },
            PanelIcon,
          ));

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'bizflow' }, Page(ctx, t)));
      },
    };
  },
});
