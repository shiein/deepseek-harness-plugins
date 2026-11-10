/**
 * Agent Assets — Client half.
 *
 * Registers a left-sidebar entry and a management page in the main column:
 * header + workspace selector, scope summary tiles, tab bar, scope filter + search, and a grouped
 * list whose rows open detail / editor / confirm dialogs. Data comes from the plugin's loopback JSON
 * API (`/api/dsh-agent-assets/*`); nothing is polled and nothing is written outside the React tree.
 *
 * Plain ESM (no JSX, no build step): the host loads this file through `window.__ModuleLoader__` and
 * we only require React. All visible copy lives in the `zh`/`en` dictionaries below (zh is source).
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-agent-assets',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'agent-assets';
    const PANEL_ID = 'agent-assets';
    const PANEL_ORDER = 30;
    const API_BASE = '/api/dsh-agent-assets';
    const STALE_MS = 30_000;
    const TOAST_MS = 2_600;
    const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
    const SCOPE_ORDER = ['workspace', 'user', 'bundled'];
    const TAB_ORDER = ['skills', 'mcp', 'instructions'];
    const TAB_PAYLOAD_PATH = { skills: '/skills', mcp: '/mcp', instructions: '/instructions' };
    const TAB_LABEL_KEY = { skills: 'tab.skills', mcp: 'tab.mcp', instructions: 'tab.instructions' };
    const TAB_CREATE_KEY = {
      skills: 'action.newSkill',
      mcp: 'action.newMcp',
      instructions: 'action.newInstruction',
    };

    // -------------------------------------------------------------------------------------
    // Copy — zh is the source language, en mirrors every key.
    // -------------------------------------------------------------------------------------

    const zh = {
      'entry.label': 'Agent 资产',
      'page.title': 'Agent 资产',
      'page.subtitle': '管理技能 · MCP · Agent 提示词，按作用范围分组',
      'page.aria': 'Agent 资产管理',
      'action.refresh': '刷新',
      'action.refreshing': '刷新中',
      'action.retry': '重试',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.save': '保存',
      'action.saving': '保存中…',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.create': '创建',
      'action.newSkill': '新建技能',
      'action.newMcp': '新建 MCP',
      'action.newInstruction': '新建提示词文件',
      'action.clearFilters': '清除筛选',

      'tab.skills': '技能',
      'tab.mcp': 'MCP 服务',
      'tab.instructions': 'Agent 提示词',
      'tabs.aria': '资产分类',

      'stat.skills': '技能',
      'stat.mcp': 'MCP',
      'stat.instructions': 'Agent 提示词',
      'stat.builtin': '内置（只读）',
      'stat.builtinHint': '随 Harness 内置，不可修改',
      'stat.skillsHint': '用户 {user} · 工作区 {workspace} · 内置 {bundled}',
      'stat.mcpHint': '外部配置 {external} 个',
      'stat.instructionsHint': '已存在 {exists} / {total}',
      'stat.unknown': '尚未加载',

      'scope.all': '全部',
      'scope.user': '用户级',
      'scope.workspace': '工作区级',
      'scope.bundled': '内置',
      'filter.scopeAria': '按作用范围筛选',

      'section.user': '用户级 · {home}',
      'section.workspace': '工作区级 · {name}',
      'section.bundled': '内置（只读）',
      'section.count': '{count} 项',

      'search.placeholder': '搜索名称、描述或路径',
      'search.aria': '搜索',
      'search.clear': '清除搜索',

      'workspace.label': '工作区',
      'workspace.aria': '切换工作区',
      'workspace.none': '未发现工作区',
      'state.loadingAria': '正在加载',
      'state.empty.skills.title': '还没有可管理的技能',
      'state.empty.skills.body':
        '在用户级 ~/.dsh/skills 或当前工作区的 .dsh/skills 下创建第一个技能，Harness 会立即加载它。',
      'state.empty.mcp.title': '还没有 MCP 服务',
      'state.empty.mcp.body': '添加一个 MCP 服务后，它会被挂载到 Harness，并在这里显示实时连接状态。',
      'state.empty.instructions.title': '还没有 Agent 提示词文件',
      'state.empty.instructions.body':
        'Agent 提示词文件用于向 Agent 说明工作区约定，可通过「新建提示词文件」从固定候选开始创建。',
      'state.emptyFilter.title': '当前筛选下没有结果',
      'state.emptyFilter.body': '调整搜索关键词或作用范围筛选后再试。',
      'state.error.title': '读取失败',
      'state.unsupported.title': '当前 Host 不支持此分类',
      'state.unsupported.body': 'Host API 未启用 {feature} 支持，请升级 Harness 或检查插件版本。',
      'state.noWorkspace.title': '未发现可用工作区',
      'state.noWorkspace.body': 'Host 没有返回默认工作区，无法读取工作区级资产。请检查 Harness 的工作区配置。',
      'state.warnings': '{count} 条读取提示',

      'error.detail': '{code}：{message}',
      'error.fallback.title': '出错了',
      'error.fallback.body': '此面板渲染失败，错误已记录到控制台。',
      'error.fallback.action': '重新打开',

      'badge.readonly': '只读',
      'badge.shadowed': '遮蔽 {count}',
      'badge.exists': '已创建',
      'badge.missing': '未创建',
      'badge.external': '外部',

      'mcp.status.connected': '已连接',
      'mcp.status.connecting': '连接中',
      'mcp.status.disabled': '已禁用',
      'mcp.status.error': '错误',
      'mcp.status.sessionScoped': '会话级',
      'mcp.status.untrusted': '待信任',
      'mcp.trust.note': '这条配置不是在此面板中创建的，确认命令和参数可信后，新会话才会启动它。',
      'mcp.trust.action': '信任此配置',
      'mcp.status.unknown': '未知',
      'mcp.status.tools': '{label} · {count} 个工具',
      'mcp.external.note': '另有 {count} 个由已安装 Bundle 提供的 MCP 配置（只读）',
      'mcp.switch.enable': '启用 {name}',
      'mcp.switch.disable': '禁用 {name}',

      'row.aria': '打开 {name} 的详情',
      'row.unknownName': '（未命名）',
      'row.actions': '行操作',

      'detail.breadcrumb': '{section} / {name}',
      'detail.section.content': '内容',
      'detail.section.config': '配置',
      'detail.field.path': '路径',
      'detail.field.summary': '摘要',
      'detail.field.description': '描述',
      'detail.field.whenToUse': '何时使用',
      'detail.field.size': '大小',
      'detail.field.modified': '修改时间',
      'detail.field.command': '命令',
      'detail.field.args': '参数',
      'detail.field.cwd': '工作目录',
      'detail.field.url': '地址',
      'detail.field.env': '环境变量',
      'detail.field.headers': '请求头',
      'detail.field.enabled': '启用',
      'detail.field.shadowed': '被遮蔽的同名技能',
      'detail.emptyBody': '（无内容）',
      'detail.missingFile': '文件尚未创建，点击「创建」写入内容。',
      'detail.secrets.show': '显示敏感值',
      'detail.secrets.hide': '隐藏敏感值',
      'detail.none': '—',

      'editor.skill.createTitle': '新建技能',
      'editor.skill.editTitle': '编辑技能',
      'editor.skill.name': '名称',
      'editor.skill.namePlaceholder': 'location-map',
      'editor.skill.nameHint': '小写字母、数字或连字符，例如 location-map',
      'editor.skill.nameRequired': '请填写名称',
      'editor.skill.nameInvalid': '只能使用小写字母、数字和连字符，且以字母或数字开头',
      'editor.skill.description': '描述',
      'editor.skill.descriptionHint': '单行，最多 1024 个字符',
      'editor.skill.descriptionRequired': '请填写描述',
      'editor.skill.descriptionInvalid': '描述不能包含换行，且最多 1024 个字符',
      'editor.skill.whenToUse': '何时使用（可选）',
      'editor.skill.whenToUseHint': '单行提示，例如：设计区位图或场地分析图时',
      'editor.skill.body': '内容（Markdown）',
      'editor.skill.bodyHint': '保存为 SKILL.md 的正文部分',
      'editor.scope': '作用范围',
      'editor.skill.scope': '作用范围',
      'editor.skill.pathNote': '保存位置：{root}/<名称>/SKILL.md',

      'editor.instruction.createTitle': '新建提示词文件',
      'editor.instruction.editTitle': '编辑提示词文件',
      'editor.instruction.createMissingTitle': '创建提示词文件',
      'editor.instruction.file': '文件',
      'editor.instruction.fileHint': '选择要创建的固定文件之一',
      'editor.instruction.none': '所有固定提示词文件均已存在，请直接编辑。',
      'editor.instruction.noCandidates': '没有可用的固定候选文件，请刷新后重试。',
      'editor.instruction.content': '内容',
      'editor.instruction.contentHint': '保存为文件原始内容（Markdown）',
      'editor.instruction.missingHint': '该文件尚未创建，保存后会新建。',

      'editor.mcp.createTitle': '新建 MCP 服务',
      'editor.mcp.editTitle': '编辑 MCP 服务',
      'editor.mcp.name': '名称',
      'editor.mcp.namePlaceholder': 'files',
      'editor.mcp.nameHint': '字母、数字、下划线或连字符，最多 32 个字符',
      'editor.mcp.nameRequired': '请填写名称',
      'editor.mcp.nameInvalid': '只能使用字母、数字、下划线或连字符（1–32 个字符）',
      'editor.mcp.scope': '作用范围',
      'editor.mcp.scopeHint': '用户级对所有会话生效；工作区级仅对当前工作区生效',
      'editor.mcp.transport': '传输方式',
      'editor.mcp.transport.stdio': 'stdio',
      'editor.mcp.transport.http': 'streamable-http',
      'editor.mcp.command': '命令',
      'editor.mcp.commandPlaceholder': '例如 npx',
      'editor.mcp.commandRequired': '请填写命令',
      'editor.mcp.args': '参数（每行一个）',
      'editor.mcp.argsHint': '每行一个参数，空行会被忽略',
      'editor.mcp.cwd': '工作目录（可选）',
      'editor.mcp.cwdPlaceholder': '/abs/path',
      'editor.mcp.url': '地址',
      'editor.mcp.urlPlaceholder': 'https://example.com/mcp',
      'editor.mcp.urlRequired': '请填写以 http:// 或 https:// 开头的绝对地址',
      'editor.mcp.env': '环境变量（KEY=VALUE，每行一个）',
      'editor.mcp.envHint': '每行一个 KEY=VALUE',
      'editor.mcp.headers': '请求头（KEY: VALUE，每行一个）',
      'editor.mcp.headersHint': '每行一个 KEY: VALUE',
      'editor.mcp.headersPlaceholder': 'Authorization: Bearer …',
      'editor.mcp.invalidEnv': '第 {line} 行不是 KEY=VALUE 格式',
      'editor.mcp.invalidHeader': '第 {line} 行不是 KEY: VALUE 格式',
      'editor.mcp.enabled': '启用',
      'editor.mcp.storeWarning':
        '环境变量与请求头以明文保存到 {userPath} 或 {workspacePath}，请勿写入无法承担的凭据。',
      'editor.mcp.workspaceSecrets':
        '工作区配置保存在项目目录内（{path}），容易随仓库一起提交。含令牌的值建议放到用户级服务器，或把该文件加入 .gitignore。',
      'editor.mcp.windowsShim':
        'Windows 上 {command} 是 .cmd 脚本，直接启动可能失败；若连接报错，命令改为 cmd，参数第一行写 /c，第二行写 {command}。',
      'editor.mcp.sessionScoped': '工作区级服务器只挂载到之后新建的、位于该工作区内的会话；已打开的会话需要新建会话后才能使用。',
      'editor.loading': '正在读取当前配置…',
      'editor.loadFailed': '读取当前配置失败',

      'confirm.skill.title': '删除技能',
      'confirm.instruction.title': '删除提示词文件',
      'confirm.mcp.title': '删除 MCP 服务',
      'confirm.body': '将永久删除「{name}」，路径：{path}。此操作无法撤销。',
      'confirm.bodyNoPath': '将永久删除「{name}」。此操作无法撤销。',
      'badge.link': '链接',
      'badge.linkHint': '链接到 {path}，在那里修改',
      'discard.title': '放弃未保存的修改？',
      'discard.body': '关闭后，这次编辑的内容不会保存。',
      'discard.confirm': '放弃修改',
      'discard.keep': '继续编辑',

      'action.importSkill': '导入技能',
      'import.title': '导入技能',
      'import.subtitle': '从本地文件夹、SKILL.md 或 .zip / .skill 压缩包导入',
      'import.source': '来源路径',
      'import.sourcePlaceholder': '例如 ~/Downloads/my-skill 或 ~/Downloads/skills.zip',
      'import.browse': '选择文件夹…',
      'import.scan': '扫描',
      'import.scanning': '扫描中…',
      'import.rescan': '来源或作用范围已变化，请重新扫描。',
      'import.hint': '识别单个技能文件夹、包含多个技能的文件夹，以及仓库中的 skills/<name>/ 结构；node_modules、.git 与符号链接不会被复制。',
      'import.target': '安装到 {path}',
      'import.found': '找到 {n} 个技能',
      'import.none': '没有找到包含 SKILL.md 的技能文件夹',
      'import.conflict': '已存在',
      'import.invalid': '不可导入',
      'import.overwrite': '覆盖同名技能',
      'import.overwriteHint': '替换已有同名技能的整个文件夹',
      'import.submit': '导入 {n} 个',
      'import.importing': '导入中…',
      'import.files': '{files} 个文件 · {size}',
      'toast.skill.imported': '已导入 {n} 个技能',
      'toast.skill.importPartial': '已导入 {n} 个，{m} 个未导入',
      'toast.skill.created': '技能「{name}」已创建',
      'toast.skill.updated': '技能「{name}」已保存',
      'toast.skill.deleted': '技能「{name}」已删除',
      'toast.instruction.saved': '提示词文件「{name}」已保存',
      'toast.instruction.deleted': '提示词文件「{name}」已删除',
      'toast.mcp.created': 'MCP 服务「{name}」已创建',
      'toast.mcp.updated': 'MCP 服务「{name}」已保存',
      'toast.mcp.deleted': 'MCP 服务「{name}」已删除',
      'toast.mcp.enabled': '已启用「{name}」',
      'toast.mcp.trusted': '已信任「{name}」，新会话会启动它',
      'toast.mcp.disabled': '已禁用「{name}」',
      'toast.failed': '操作失败',

      'unit.bytes': 'B',
      'unit.kb': 'KB',
      'unit.mb': 'MB',
    };

    const en = {
      'entry.label': 'Agent Assets',
      'page.title': 'Agent Assets',
      'page.subtitle': 'Manage skills, MCP servers and agent prompts, grouped by scope',
      'page.aria': 'Agent assets management',
      'action.refresh': 'Refresh',
      'action.refreshing': 'Refreshing',
      'action.retry': 'Retry',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.create': 'Create',
      'action.newSkill': 'New skill',
      'action.newMcp': 'New MCP',
      'action.newInstruction': 'New prompt file',
      'action.clearFilters': 'Clear filters',

      'tab.skills': 'Skills',
      'tab.mcp': 'MCP servers',
      'tab.instructions': 'Agent prompts',
      'tabs.aria': 'Asset categories',

      'stat.skills': 'Skills',
      'stat.mcp': 'MCP',
      'stat.instructions': 'Agent prompts',
      'stat.builtin': 'Built-in (read-only)',
      'stat.builtinHint': 'Shipped with Harness, read-only',
      'stat.skillsHint': 'User {user} · Workspace {workspace} · Built-in {bundled}',
      'stat.mcpHint': 'External configs: {external}',
      'stat.instructionsHint': 'Existing {exists} / {total}',
      'stat.unknown': 'Not loaded yet',

      'scope.all': 'All',
      'scope.user': 'User',
      'scope.workspace': 'Workspace',
      'scope.bundled': 'Built-in',
      'filter.scopeAria': 'Filter by scope',

      'section.user': 'User · {home}',
      'section.workspace': 'Workspace · {name}',
      'section.bundled': 'Built-in (read-only)',
      'section.count': '{count} items',

      'search.placeholder': 'Search name, description or path',
      'search.aria': 'Search',
      'search.clear': 'Clear search',

      'workspace.label': 'Workspace',
      'workspace.aria': 'Switch workspace',
      'workspace.none': 'No workspace found',
      'state.loadingAria': 'Loading',
      'state.empty.skills.title': 'No manageable skills yet',
      'state.empty.skills.body':
        'Create the first skill under ~/.dsh/skills (user scope) or .dsh/skills in the current workspace; Harness loads it immediately.',
      'state.empty.mcp.title': 'No MCP servers yet',
      'state.empty.mcp.body':
        'Add an MCP server and it is mounted into Harness; its live connection status appears here.',
      'state.empty.instructions.title': 'No agent prompt files yet',
      'state.empty.instructions.body':
        'Agent prompt files describe workspace conventions to the agent. Use "New prompt file" to create one of the fixed candidates.',
      'state.emptyFilter.title': 'No results under the current filters',
      'state.emptyFilter.body': 'Adjust the search text or the scope filter and try again.',
      'state.error.title': 'Request failed',
      'state.unsupported.title': 'This host does not support this category',
      'state.unsupported.body': 'The host API has {feature} disabled; upgrade Harness or check the plugin version.',
      'state.noWorkspace.title': 'No workspace available',
      'state.noWorkspace.body': 'The host did not return a default workspace, so workspace-scoped assets cannot be read. Check the Harness workspace configuration.',
      'state.warnings': '{count} read warning(s)',

      'error.detail': '{code}: {message}',
      'error.fallback.title': 'Something went wrong',
      'error.fallback.body': 'This panel failed to render; the error was logged to the console.',
      'error.fallback.action': 'Reopen',

      'badge.readonly': 'Read-only',
      'badge.shadowed': 'Shadowed {count}',
      'badge.exists': 'Created',
      'badge.missing': 'Not created',
      'badge.external': 'External',

      'mcp.status.connected': 'Connected',
      'mcp.status.connecting': 'Connecting',
      'mcp.status.disabled': 'Disabled',
      'mcp.status.error': 'Error',
      'mcp.status.sessionScoped': 'Session-scoped',
      'mcp.status.untrusted': 'Needs trust',
      'mcp.trust.note': 'This entry was not created in this panel. New sessions start it only after you confirm its command and arguments are safe.',
      'mcp.trust.action': 'Trust this entry',
      'mcp.status.unknown': 'Unknown',
      'mcp.status.tools': '{label} · {count} tools',
      'mcp.external.note': '{count} more MCP config(s) are provided by installed bundles (read-only)',
      'mcp.switch.enable': 'Enable {name}',
      'mcp.switch.disable': 'Disable {name}',

      'row.aria': 'Open details for {name}',
      'row.unknownName': '(unnamed)',
      'row.actions': 'Row actions',

      'detail.breadcrumb': '{section} / {name}',
      'detail.section.content': 'Content',
      'detail.section.config': 'Configuration',
      'detail.field.path': 'Path',
      'detail.field.summary': 'Summary',
      'detail.field.description': 'Description',
      'detail.field.whenToUse': 'When to use',
      'detail.field.size': 'Size',
      'detail.field.modified': 'Modified',
      'detail.field.command': 'Command',
      'detail.field.args': 'Arguments',
      'detail.field.cwd': 'Working directory',
      'detail.field.url': 'URL',
      'detail.field.env': 'Environment',
      'detail.field.headers': 'Headers',
      'detail.field.enabled': 'Enabled',
      'detail.field.shadowed': 'Shadowed skills with the same name',
      'detail.emptyBody': '(empty)',
      'detail.missingFile': 'This file does not exist yet. Choose Create to write it.',
      'detail.secrets.show': 'Show sensitive values',
      'detail.secrets.hide': 'Hide sensitive values',
      'detail.none': '—',

      'editor.skill.createTitle': 'New skill',
      'editor.skill.editTitle': 'Edit skill',
      'editor.skill.name': 'Name',
      'editor.skill.namePlaceholder': 'location-map',
      'editor.skill.nameHint': 'Lowercase letters, digits or hyphens, e.g. location-map',
      'editor.skill.nameRequired': 'Name is required',
      'editor.skill.nameInvalid': 'Use lowercase letters, digits and hyphens, starting with a letter or digit',
      'editor.skill.description': 'Description',
      'editor.skill.descriptionHint': 'A single line, at most 1024 characters',
      'editor.skill.descriptionRequired': 'Description is required',
      'editor.skill.descriptionInvalid': 'Description must be a single line of at most 1024 characters',
      'editor.skill.whenToUse': 'When to use (optional)',
      'editor.skill.whenToUseHint': 'One-line hint, e.g. when designing a location or site-analysis map',
      'editor.skill.body': 'Content (Markdown)',
      'editor.skill.bodyHint': 'Saved as the body of SKILL.md',
      'editor.scope': 'Scope',
      'editor.skill.scope': 'Scope',
      'editor.skill.pathNote': 'Writes to: {root}/<name>/SKILL.md',

      'editor.instruction.createTitle': 'New prompt file',
      'editor.instruction.editTitle': 'Edit prompt file',
      'editor.instruction.createMissingTitle': 'Create prompt file',
      'editor.instruction.file': 'File',
      'editor.instruction.fileHint': 'Pick one of the fixed files to create',
      'editor.instruction.none': 'All fixed prompt files already exist; edit them directly.',
      'editor.instruction.noCandidates': 'No fixed candidates are available; refresh and try again.',
      'editor.instruction.content': 'Content',
      'editor.instruction.contentHint': 'Saved verbatim as the file content (Markdown)',
      'editor.instruction.missingHint': 'This file does not exist yet; saving will create it.',

      'editor.mcp.createTitle': 'New MCP server',
      'editor.mcp.editTitle': 'Edit MCP server',
      'editor.mcp.name': 'Name',
      'editor.mcp.namePlaceholder': 'files',
      'editor.mcp.nameHint': 'Letters, digits, underscores or hyphens, at most 32 characters',
      'editor.mcp.nameRequired': 'Name is required',
      'editor.mcp.nameInvalid': 'Use letters, digits, underscores or hyphens (1–32 characters)',
      'editor.mcp.scope': 'Scope',
      'editor.mcp.scopeHint': 'User scope applies to every session; workspace scope only to the current workspace',
      'editor.mcp.transport': 'Transport',
      'editor.mcp.transport.stdio': 'stdio',
      'editor.mcp.transport.http': 'streamable-http',
      'editor.mcp.command': 'Command',
      'editor.mcp.commandPlaceholder': 'e.g. npx',
      'editor.mcp.commandRequired': 'Command is required',
      'editor.mcp.args': 'Arguments (one per line)',
      'editor.mcp.argsHint': 'One argument per line; blank lines are ignored',
      'editor.mcp.cwd': 'Working directory (optional)',
      'editor.mcp.cwdPlaceholder': '/abs/path',
      'editor.mcp.url': 'URL',
      'editor.mcp.urlPlaceholder': 'https://example.com/mcp',
      'editor.mcp.urlRequired': 'Enter an absolute http:// or https:// URL',
      'editor.mcp.env': 'Environment (KEY=VALUE, one per line)',
      'editor.mcp.envHint': 'One KEY=VALUE per line',
      'editor.mcp.headers': 'Headers (KEY: VALUE, one per line)',
      'editor.mcp.headersHint': 'One KEY: VALUE per line',
      'editor.mcp.headersPlaceholder': 'Authorization: Bearer …',
      'editor.mcp.invalidEnv': 'Line {line} is not in KEY=VALUE form',
      'editor.mcp.invalidHeader': 'Line {line} is not in KEY: VALUE form',
      'editor.mcp.enabled': 'Enabled',
      'editor.mcp.storeWarning':
        'Environment variables and headers are stored in plain text under {userPath} or {workspacePath}. Do not put credentials there that you cannot afford to expose.',
      'editor.mcp.workspaceSecrets':
        'The workspace store lives inside the project ({path}) and is easily committed with it. Keep tokens in a user-scope server, or add that file to .gitignore.',
      'editor.mcp.windowsShim':
        'On Windows {command} is a .cmd script and may fail to start directly; if it does, set the command to cmd with /c and {command} as the first two arguments.',
      'editor.mcp.sessionScoped': 'Workspace servers mount only on sessions created afterwards inside this workspace; start a new session to use them.',
      'editor.loading': 'Reading the current configuration…',
      'editor.loadFailed': 'Failed to read the current configuration',

      'confirm.skill.title': 'Delete skill',
      'confirm.instruction.title': 'Delete prompt file',
      'confirm.mcp.title': 'Delete MCP server',
      'confirm.body': 'This permanently deletes "{name}" at {path}. This cannot be undone.',
      'confirm.bodyNoPath': 'This permanently deletes "{name}". This cannot be undone.',
      'badge.link': 'Link',
      'badge.linkHint': 'Links to {path}; edit it there',
      'discard.title': 'Discard unsaved changes?',
      'discard.body': 'Closing now drops what you edited in this dialog.',
      'discard.confirm': 'Discard',
      'discard.keep': 'Keep editing',

      'action.importSkill': 'Import',
      'import.title': 'Import skills',
      'import.subtitle': 'From a local folder, a SKILL.md file or a .zip / .skill archive',
      'import.source': 'Source path',
      'import.sourcePlaceholder': 'e.g. ~/Downloads/my-skill or ~/Downloads/skills.zip',
      'import.browse': 'Browse…',
      'import.scan': 'Scan',
      'import.scanning': 'Scanning…',
      'import.rescan': 'Source or scope changed — scan again.',
      'import.hint': 'Finds a single skill folder, a folder of skills, or a repository with skills/<name>/; node_modules, .git and symlinks are never copied.',
      'import.target': 'Installs into {path}',
      'import.found': '{n} skills found',
      'import.none': 'No folder with a SKILL.md was found',
      'import.conflict': 'Exists',
      'import.invalid': 'Not importable',
      'import.overwrite': 'Overwrite same-name skills',
      'import.overwriteHint': 'Replaces the whole folder of the existing skill',
      'import.submit': 'Import {n}',
      'import.importing': 'Importing…',
      'import.files': '{files} files · {size}',
      'toast.skill.imported': 'Imported {n} skills',
      'toast.skill.importPartial': 'Imported {n}, {m} not imported',
      'toast.skill.created': 'Skill "{name}" created',
      'toast.skill.updated': 'Skill "{name}" saved',
      'toast.skill.deleted': 'Skill "{name}" deleted',
      'toast.instruction.saved': 'Prompt file "{name}" saved',
      'toast.instruction.deleted': 'Prompt file "{name}" deleted',
      'toast.mcp.created': 'MCP server "{name}" created',
      'toast.mcp.updated': 'MCP server "{name}" saved',
      'toast.mcp.deleted': 'MCP server "{name}" deleted',
      'toast.mcp.enabled': '"{name}" enabled',
      'toast.mcp.trusted': '"{name}" trusted; new sessions will start it',
      'toast.mcp.disabled': '"{name}" disabled',
      'toast.failed': 'Operation failed',

      'unit.bytes': 'B',
      'unit.kb': 'KB',
      'unit.mb': 'MB',
    };

    // -------------------------------------------------------------------------------------
    // Locale plumbing
    // -------------------------------------------------------------------------------------

    const DICTS = { zh, en };

    function makeTranslate(ctx) {
      function currentLocale() {
        try {
          const snapshot = ctx.locale.getSnapshot();
          // LocaleRuntime snapshots are { active, locales, revision }.
          const id = snapshot?.active || snapshot?.locale || snapshot?.id || snapshot?.language || '';
          if (typeof id === 'string' && id.toLowerCase().startsWith('zh')) return 'zh';
          if (typeof id === 'string' && id !== '') return 'en';
        } catch {
          // Locale service unavailable: keep the default copy language.
        }
        return 'zh';
      }
      function translate(key, values) {
        const locale = currentLocale();
        const dict = DICTS[locale] || zh;
        let text = dict[key] ?? en[key] ?? key;
        if (values) {
          for (const [name, value] of Object.entries(values)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      }
      translate.currentLocale = currentLocale;
      return translate;
    }

    function useLocaleTick(subscribeLocale) {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (typeof subscribeLocale !== 'function') return undefined;
        let dispose = null;
        try {
          dispose = subscribeLocale(() => setTick((value) => value + 1));
        } catch {
          dispose = null;
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, [subscribeLocale]);
      return tick;
    }

    // -------------------------------------------------------------------------------------
    // Formatting helpers
    // -------------------------------------------------------------------------------------

    function formatNumber(value, locale) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      try {
        return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(number);
      } catch {
        return String(number);
      }
    }

    function formatBytes(bytes, t) {
      const number = Number(bytes);
      if (!Number.isFinite(number) || number < 0) return t('detail.none');
      if (number < 1024) return `${Math.round(number)} ${t('unit.bytes')}`;
      if (number < 1024 * 1024) return `${(number / 1024).toFixed(number < 10240 ? 1 : 0)} ${t('unit.kb')}`;
      return `${(number / 1024 / 1024).toFixed(1)} ${t('unit.mb')}`;
    }

    function formatDateTime(iso, locale) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      try {
        return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date);
      } catch {
        return date.toISOString().slice(0, 16).replace('T', ' ');
      }
    }

    function baseName(value) {
      const parts = String(value || '')
        .split(/[\\/]/)
        .filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : String(value || '');
    }

    /** `~/.dsh` when the home directory uses the conventional name, the raw path otherwise. */
    function shortHomePath(homes) {
      const dshHome = String(homes?.dshHome || '');
      if (!dshHome) return '~/.dsh';
      return /[\\/]\.dsh$/.test(dshHome) ? '~/.dsh' : dshHome;
    }

    /** Join display path segments with the separator the base already uses (`\` on Windows paths). */
    function displayJoin(base, ...parts) {
      const text = String(base || '');
      const separator = text.includes('\\') && !text.includes('/') ? '\\' : '/';
      return [text.replace(/[\\/]+$/, ''), ...parts].join(separator);
    }

    // -------------------------------------------------------------------------------------
    // Active-session workspace preference (client-only; no API contract change)
    // -------------------------------------------------------------------------------------

    const EMPTY_SESSION_STATE = { ids: [], byId: {} };

    function isWindowsPlatform() {
      try {
        if (typeof process !== 'undefined' && process && typeof process.platform === 'string') {
          return process.platform === 'win32';
        }
      } catch {
        // process is not available in the browser renderer.
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.platform === 'string') {
          return /^win/i.test(navigator.platform);
        }
      } catch {
        // navigator is not available during SSR.
      }
      return false;
    }

    /** Normalized workspace path for comparison (case-insensitive on Windows). */
    function normalizeWorkspacePath(value) {
      let path = String(value || '').trim();
      if (!path) return '';
      path = path.replace(/\\/g, '/');
      if (path.length > 1) path = path.replace(/\/+$/, '');
      return isWindowsPlatform() ? path.toLowerCase() : path;
    }

    /** Most relevant session cwd: the most recent host list order first, then any row with a cwd. */
    function deriveSessionCwd(state) {
      try {
        if (!state || typeof state !== 'object') return null;
        const byId = state.byId && typeof state.byId === 'object' ? state.byId : null;
        if (!byId) return null;
        const ids = Array.isArray(state.ids) ? state.ids : [];
        for (const id of ids) {
          const row = byId[id];
          const cwd = row && typeof row.cwd === 'string' ? row.cwd.trim() : '';
          if (cwd) return cwd;
        }
        for (const row of Object.values(byId)) {
          const cwd = row && typeof row.cwd === 'string' ? row.cwd.trim() : '';
          if (cwd) return cwd;
        }
      } catch {
        // A malformed snapshot must never break the page.
      }
      return null;
    }

    /** Stable selector passed to the host `useSessions` hook. */
    function selectSessionCwd(state) {
      return deriveSessionCwd(state);
    }

    /** Fallback when the host does not provide `useSessions` (render tests, future hosts). */
    function noopUseSessions(selector) {
      try {
        return typeof selector === 'function' ? selector(EMPTY_SESSION_STATE) : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Preferred initial workspace: the active session cwd when it is a registered workspace (or the
     * bootstrap default); otherwise the bootstrap default.
     */
    function preferredWorkspace(bootstrap, sessionCwd) {
      const defaultWorkspace = String(bootstrap?.defaultWorkspace || '');
      const candidate = String(sessionCwd || '').trim();
      if (!candidate) return defaultWorkspace;
      const target = normalizeWorkspacePath(candidate);
      const workspaces = Array.isArray(bootstrap?.workspaces) ? bootstrap.workspaces : [];
      const match = workspaces.find(
        (entry) => entry && typeof entry.path === 'string' && normalizeWorkspacePath(entry.path) === target,
      );
      if (match) return String(match.path);
      // The default is only accepted when it normalizes to the same path; any other unregistered
      // session cwd falls back to the Host default instead of pointing at an arbitrary directory.
      return defaultWorkspace;
    }

    function scopeKey(scope) {
      if (scope === 'user') return 'scope.user';
      if (scope === 'workspace') return 'scope.workspace';
      return 'scope.bundled';
    }

    function rowKey(tab, item) {
      if (tab === 'skills') return `skill:${item.scope}:${item.name}`;
      if (tab === 'instructions') return `instruction:${item.scope}:${item.path}`;
      return `mcp:${item.scope}:${item.serverName}`;
    }

    function displayEntityName(tab, item, t) {
      if (tab === 'skills') return item?.name || t('row.unknownName');
      if (tab === 'instructions') return item?.label || item?.file || item?.path || t('row.unknownName');
      return item?.serverName || t('row.unknownName');
    }

    function tabSupported(tab, bootstrap) {
      const supports = bootstrap?.supports;
      if (!supports || typeof supports !== 'object') return true;
      return supports[tab] !== false;
    }

    // -------------------------------------------------------------------------------------
    // API helpers
    // -------------------------------------------------------------------------------------

    function buildUrl(path, params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
      }
      const query = search.toString();
      return `${API_BASE}${path}${query ? `?${query}` : ''}`;
    }

    function makeApiError(code, message, status) {
      const error = new Error(message || code || 'request failed');
      error.code = code || 'internal';
      error.status = status || 0;
      return error;
    }

    function errorInfo(error) {
      if (!error) return { code: 'internal', message: 'unknown error', status: 0 };
      return {
        code: typeof error.code === 'string' && error.code ? error.code : 'internal',
        message: typeof error.message === 'string' && error.message ? error.message : String(error),
        status: Number(error.status) || 0,
      };
    }

    function describeApiError(t, info) {
      if (!info) return '';
      return t('error.detail', { code: info.code, message: info.message });
    }

    async function requestJson(path, options) {
      const method = options?.method || 'GET';
      const headers = { accept: 'application/json' };
      if (options?.body !== undefined) headers['content-type'] = 'application/json';
      let response;
      try {
        response = await fetch(buildUrl(path, options?.params), {
          method,
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
          body: options?.body === undefined ? undefined : JSON.stringify(options.body),
          signal: options?.signal,
        });
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw makeApiError('network', error?.message || 'network request failed', 0);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const code = payload?.error?.code || (response.ok ? 'internal' : `http_${response.status}`);
        const message = payload?.error?.message || `HTTP ${response.status}`;
        throw makeApiError(code, message, response.status);
      }
      return payload;
    }

    async function fetchDetailPayload(tab, target, workspace, signal) {
      if (tab === 'skills') {
        const payload = await requestJson('/skill', {
          params: { scope: target?.scope, name: target?.name, workspace },
          signal,
        });
        return payload.skill || null;
      }
      if (tab === 'instructions') {
        const payload = await requestJson('/instruction', {
          params: { scope: target?.scope, path: target?.path, workspace },
          signal,
        });
        return payload.instruction || null;
      }
      const payload = await requestJson('/mcp/detail', {
        params: { scope: target?.scope, serverName: target?.serverName, workspace },
        signal,
      });
      return payload.server || null;
    }

    /** Accepts missing/garbage API fields so one bad row can never blank the list. */
    function normalizeSkill(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        kind: 'skill',
        name: String(source.name || ''),
        description: String(source.description || ''),
        whenToUse: source.whenToUse ? String(source.whenToUse) : null,
        scope: source.scope === 'user' || source.scope === 'workspace' ? source.scope : 'bundled',
        source: String(source.source || ''),
        provider: String(source.provider || ''),
        path: typeof source.path === 'string' && source.path ? source.path : null,
        dir: typeof source.dir === 'string' && source.dir ? source.dir : null,
        editable: Boolean(source.editable),
        linkTarget: typeof source.linkTarget === 'string' && source.linkTarget ? source.linkTarget : null,
        shadowed: Array.isArray(source.shadowed)
          ? source.shadowed.filter((entry) => entry && typeof entry === 'object')
          : [],
      };
    }

    function normalizeInstruction(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      return {
        kind: 'instruction',
        id: String(source.id || ''),
        scope: source.scope === 'user' || source.scope === 'workspace' ? source.scope : 'workspace',
        file: String(source.file || baseName(source.path || '')),
        label: String(source.label || source.file || baseName(source.path || '')),
        path: String(source.path || ''),
        displayPath: String(source.displayPath || source.path || ''),
        exists: Boolean(source.exists),
        editable: source.editable !== false,
        size: Number(source.size) || 0,
        modifiedAt: typeof source.modifiedAt === 'string' ? source.modifiedAt : null,
      };
    }

    function normalizeMcp(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const status = source.status && typeof source.status === 'object' ? source.status : {};
      const tools = Number(status.tools);
      return {
        kind: 'mcp',
        serverName: String(source.serverName || ''),
        scope: source.scope === 'user' || source.scope === 'workspace' ? source.scope : 'user',
        transport: source.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        summary: String(source.summary || ''),
        enabled: source.enabled !== false,
        status: {
          state: typeof status.state === 'string' && status.state ? status.state : 'unknown',
          tools: Number.isFinite(tools) ? tools : 0,
          error: typeof status.error === 'string' && status.error ? status.error : null,
        },
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : null,
        updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
      };
    }

    function mcpStatusLabel(t, status) {
      const state = status?.state || 'unknown';
      const label = t(
        state === 'connected'
          ? 'mcp.status.connected'
          : state === 'connecting'
            ? 'mcp.status.connecting'
            : state === 'disabled'
              ? 'mcp.status.disabled'
              : state === 'error'
                ? 'mcp.status.error'
                : state === 'session-scoped'
                  ? 'mcp.status.sessionScoped'
                  : state === 'untrusted'
                    ? 'mcp.status.untrusted'
                    : 'mcp.status.unknown',
      );
      if (state === 'connected') return t('mcp.status.tools', { label, count: Number(status?.tools) || 0 });
      return label;
    }

    function mcpStatusTone(state) {
      if (state === 'connected') return 'ok';
      if (state === 'connecting' || state === 'session-scoped' || state === 'untrusted') return 'warn';
      if (state === 'error') return 'error';
      return 'muted';
    }

    function matchesQuery(tab, item, needle) {
      if (!needle) return true;
      if (tab === 'skills') {
        return (
          item.name.toLowerCase().includes(needle) ||
          item.description.toLowerCase().includes(needle) ||
          String(item.path || '').toLowerCase().includes(needle) ||
          String(item.whenToUse || '').toLowerCase().includes(needle)
        );
      }
      if (tab === 'instructions') {
        return (
          item.label.toLowerCase().includes(needle) ||
          item.path.toLowerCase().includes(needle) ||
          item.displayPath.toLowerCase().includes(needle) ||
          item.file.toLowerCase().includes(needle)
        );
      }
      return (
        item.serverName.toLowerCase().includes(needle) ||
        item.summary.toLowerCase().includes(needle) ||
        item.transport.toLowerCase().includes(needle)
      );
    }

    // -------------------------------------------------------------------------------------
    // Hooks + error boundary
    // -------------------------------------------------------------------------------------

    function useElementSize() {
      const ref = useRef(null);
      const [size, setSize] = useState({ width: 0, height: 0 });
      useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const update = () =>
          setSize({ width: element.clientWidth || 0, height: element.clientHeight || 0 });
        update();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
      }, []);
      return [ref, size];
    }

    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.reset = this.reset.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          console.error(
            `[agent-assets] ${this.props.channel || 'ui'} render failed:`,
            error,
            info?.componentStack || '',
          );
        } catch {
          // Logging must never throw.
        }
      }

      reset() {
        this.setState({ error: null });
      }

      render() {
        if (!this.state.error) return this.props.children;
        const t = typeof this.props.t === 'function' ? this.props.t : (key) => key;
        if (this.props.channel === 'icon') {
          return h(
            'span',
            { className: 'aa-icon-fallback', title: t('error.fallback.title'), 'aria-hidden': 'true' },
            '!',
          );
        }
        return h(
          'div',
          { className: 'aa-fallback', role: 'alert' },
          h('div', { className: 'aa-fallback-title' }, t('error.fallback.title')),
          h('div', { className: 'aa-fallback-body' }, t('error.fallback.body')),
          h(
            'button',
            { type: 'button', className: 'aa-btn aa-btn-primary', onClick: this.reset },
            t('error.fallback.action'),
          ),
        );
      }
    }

    /** Wraps a slot component so a render crash can never blank the host slot. */
    function guard(Component, t, channel) {
      function Guarded(props) {
        return h(ErrorBoundary, { t, channel }, h(Component, props));
      }
      Guarded.displayName = `Guarded(${Component.displayName || Component.name || 'Component'})`;
      return Guarded;
    }

    // -------------------------------------------------------------------------------------
    // Icons (artwork only; everything else is themed with tokens)
    // -------------------------------------------------------------------------------------

    function IconAgentAssets({ size = 18, active = false }) {
      const edge = Number(size) || 18;
      return h(
        'svg',
        {
          viewBox: '0 0 20 20',
          width: edge,
          height: edge,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          'data-dsh-panel-entry': PANEL_ID,
          style: { display: 'block' },
        },
        h('path', { d: 'M10 2.1 17.7 5.9 10 9.7 2.3 5.9Z', fill: 'currentColor', opacity: active ? 1 : 0.92 }),
        h('path', { d: 'M10 8.1 17.7 11.9 10 15.7 2.3 11.9Z', fill: 'currentColor', opacity: active ? 0.6 : 0.48 }),
        h('path', { d: 'M10 13.5 16.6 16.8 10 19.4 3.4 16.8Z', fill: 'currentColor', opacity: active ? 0.32 : 0.24 }),
      );
    }

    function IconRefresh({ size = 14 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M13 7.4a5 5 0 1 0 .2 2' }),
        h('path', { d: 'M13.2 3.6v3.9H9.3' }),
      );
    }

    function IconSearch({ size = 13 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('circle', { cx: 7, cy: 7, r: 4.2 }),
        h('path', { d: 'M10.2 10.2 13.6 13.6' }),
      );
    }

    function IconPlus({ size = 12 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }),
      );
    }

    function IconClose({ size = 12 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
      );
    }

    function IconCheck({ size = 12 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M3.4 8.6 6.4 11.6 12.6 5.2' }),
      );
    }

    function IconAlert({ size = 12 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M8 2.6 14.2 13.4H1.8Z' }),
        h('path', { d: 'M8 6.2v3.4' }),
        h('circle', { cx: 8, cy: 11.6, r: 0.6, fill: 'currentColor', stroke: 'none' }),
      );
    }

    function IconLock({ size = 14 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 3.2, y: 7, width: 9.6, height: 6.4, rx: 1.4 }),
        h('path', { d: 'M5.4 7V5.4a2.6 2.6 0 0 1 5.2 0V7' }),
      );
    }

    /** Small per-kind glyph for row chips and empty states. */
    function KindGlyph({ tab, size = 16 }) {
      if (tab === 'mcp') {
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block' },
          },
          h('circle', { cx: 4, cy: 8, r: 1.9 }),
          h('circle', { cx: 12, cy: 4.2, r: 1.7 }),
          h('circle', { cx: 12, cy: 11.8, r: 1.7 }),
          h('path', { d: 'M5.8 7.2 10.3 4.9M5.8 8.8l4.5 2.3' }),
        );
      }
      if (tab === 'instructions') {
        return h(
          'svg',
          {
            viewBox: '0 0 16 16',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block' },
          },
          h('path', { d: 'M4 2.2h5.2L12.6 5.6v8.2H4Z' }),
          h('path', { d: 'M9.1 2.4v3.4h3.3' }),
          h('path', { d: 'M6.2 8.4h4M6.2 10.6h4' }),
        );
      }
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: 'M8 1.9 13.8 4.8 8 7.7 2.2 4.8Z', fill: 'currentColor', opacity: 0.95 }),
        h('path', { d: 'M8 6.6 13.8 9.5 8 12.4 2.2 9.5Z', fill: 'currentColor', opacity: 0.5 }),
        h('path', { d: 'M8 11.2 12.6 13.5 8 15.8 3.4 13.5Z', fill: 'currentColor', opacity: 0.25 }),
      );
    }

    function Spinner({ size = 12 }) {
      return h('span', { className: 'aa-spinner', style: { width: size, height: size }, 'aria-hidden': 'true' });
    }

    // -------------------------------------------------------------------------------------
    // Atoms
    // -------------------------------------------------------------------------------------

    function Badge({ tone = 'muted', title, children }) {
      return h('span', { className: `aa-badge aa-badge-${tone}`, title }, children);
    }

    function StatTile({ label, value, hint }) {
      return h(
        'div',
        { className: 'aa-stat' },
        h('div', { className: 'aa-stat-label' }, label),
        h('div', { className: 'aa-stat-value' }, value),
        hint ? h('div', { className: 'aa-stat-hint', title: hint }, hint) : null,
      );
    }

    function Tabs({ t, locale, tabs, active, onChange }) {
      return h(
        'div',
        { className: 'aa-tabs', role: 'tablist', 'aria-label': t('tabs.aria') },
        tabs.map((tab) =>
          h(
            'button',
            {
              key: tab.key,
              type: 'button',
              role: 'tab',
              id: `aa-tab-${tab.key}`,
              className: `aa-tab${tab.key === active ? ' is-active' : ''}`,
              'aria-selected': tab.key === active,
              'aria-controls': tab.key === active ? `aa-panel-${tab.key}` : undefined,
              onClick: () => onChange(tab.key),
            },
            h('span', { className: 'aa-tab-label' }, t(tab.labelKey)),
            tab.count === null || tab.count === undefined
              ? null
              : h('span', { className: 'aa-tab-count' }, formatNumber(tab.count, locale)),
          ),
        ),
      );
    }

    function Segmented({ value, options, onChange, ariaLabel }) {
      return h(
        'div',
        { className: 'aa-seg', role: 'group', 'aria-label': ariaLabel },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              className: `aa-seg-item${option.value === value ? ' is-active' : ''}`,
              'aria-pressed': option.value === value,
              disabled: Boolean(option.disabled),
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function SearchBox({ t, value, onChange }) {
      const inputRef = useRef(null);
      return h(
        'div',
        { className: 'aa-search' },
        h('span', { className: 'aa-search-icon' }, h(IconSearch)),
        h('input', {
          ref: inputRef,
          type: 'text',
          className: 'aa-search-input',
          value,
          placeholder: t('search.placeholder'),
          'aria-label': t('search.aria'),
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape' && value) {
              event.stopPropagation();
              onChange('');
              inputRef.current?.focus();
            }
          },
        }),
        value
          ? h(
              'button',
              {
                type: 'button',
                className: 'aa-search-clear',
                title: t('search.clear'),
                'aria-label': t('search.clear'),
                onClick: () => {
                  onChange('');
                  inputRef.current?.focus();
                },
              },
              h(IconClose),
            )
          : null,
      );
    }

    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(checked),
        'aria-label': label,
        title: label,
        className: 'aa-switch',
        disabled: Boolean(disabled),
        onClick: (event) => {
          event.stopPropagation();
          if (!disabled) onChange(!checked);
        },
        onKeyDown: (event) => event.stopPropagation(),
      });
    }

    function EmptyState({ t, icon, tab, title, body, action }) {
      return h(
        'div',
        { className: 'aa-state' },
        h(
          'div',
          { className: `aa-state-icon${icon === 'error' ? ' is-error' : ''}${icon === 'lock' ? ' is-lock' : ''}` },
          icon === 'lock'
            ? h(IconLock, { size: 18 })
            : icon === 'error'
              ? h(IconAlert, { size: 18 })
              : h(KindGlyph, { tab: tab || 'skills', size: 20 }),
        ),
        h('div', { className: 'aa-state-title' }, title),
        body ? h('div', { className: 'aa-state-body' }, body) : null,
        action || null,
      );
    }

    function InlineError({ t, info, onRetry }) {
      return h(
        'div',
        { className: 'aa-inline-error', role: 'alert' },
        h(
          'div',
          { className: 'aa-inline-error-text' },
          h('span', { className: 'aa-inline-error-title' }, t('state.error.title')),
          info ? h('span', { className: 'aa-inline-error-detail' }, describeApiError(t, info)) : null,
        ),
        onRetry
          ? h('button', { type: 'button', className: 'aa-btn aa-btn-sm', onClick: onRetry }, t('action.retry'))
          : null,
      );
    }

    function WarningNote({ t, warnings }) {
      const text = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
      if (text.length === 0) return null;
      return h(
        'div',
        { className: 'aa-note aa-note-warn', title: text.join('\n') },
        h(IconAlert, { size: 12 }),
        h('span', null, t('state.warnings', { count: text.length })),
      );
    }

    function SkeletonRows({ rows = 4, t }) {
      return h(
        'div',
        { className: 'aa-skeletons', 'aria-busy': 'true', 'aria-label': t('state.loadingAria') },
        Array.from({ length: rows }, (_, index) => h('div', { key: index, className: 'aa-skeleton-row' })),
      );
    }

    function ToastLayer({ t, toasts }) {
      if (!Array.isArray(toasts) || toasts.length === 0) return null;
      return h(
        'div',
        { className: 'aa-toasts', role: 'status', 'aria-live': 'polite' },
        toasts.map((toast) =>
          h(
            'div',
            { key: toast.id, className: `aa-toast is-${toast.kind === 'error' ? 'error' : 'success'}` },
            toast.kind === 'error' ? h(IconAlert, { size: 12 }) : h(IconCheck, { size: 12 }),
            h('span', { className: 'aa-toast-text' }, toast.message || ''),
            toast.detail ? h('span', { className: 'aa-toast-detail' }, toast.detail) : null,
          ),
        ),
      );
    }

    // -------------------------------------------------------------------------------------
    // List rows + grouped sections
    // -------------------------------------------------------------------------------------

    function Row({
      t,
      locale,
      tab,
      item,
      selected,
      onOpen,
      onEdit,
      onDelete,
      onToggle,
      togglePending,
      onSelectToggle,
    }) {
      const title = displayEntityName(tab, item, t);
      const badges = [];
      if (tab === 'skills') {
        badges.push(
          h(Badge, { key: 'scope', tone: item.editable ? 'brand' : 'muted' }, t(scopeKey(item.scope))),
        );
        if (item.source) badges.push(h(Badge, { key: 'source', tone: 'muted' }, item.source));
        if (item.linkTarget) {
          badges.push(h(Badge, { key: 'link', tone: 'muted', title: t('badge.linkHint', { path: item.linkTarget }) }, t('badge.link')));
        }
        if (item.shadowed.length > 0) {
          badges.push(
            h(
              Badge,
              { key: 'shadowed', tone: 'warn', title: item.shadowed.map((entry) => entry?.path || '').join('\n') },
              t('badge.shadowed', { count: item.shadowed.length }),
            ),
          );
        }
      } else if (tab === 'instructions') {
        badges.push(h(Badge, { key: 'scope', tone: item.editable ? 'brand' : 'muted' }, t(scopeKey(item.scope))));
      } else {
        badges.push(h(Badge, { key: 'scope', tone: 'brand' }, t(scopeKey(item.scope))));
        badges.push(h(Badge, { key: 'transport', tone: 'muted' }, item.transport));
      }

      let description = null;
      let meta = null;
      if (tab === 'skills') {
        description = item.description || null;
        meta = h(
          'span',
          { className: 'aa-row-path aa-mono', title: item.path || '' },
          item.path || t('detail.none'),
        );
      } else if (tab === 'instructions') {
        description = h('span', { className: 'aa-row-desc-mono aa-mono' }, item.displayPath || item.path || item.file);
        meta = h(
          'span',
          { className: 'aa-row-meta-facts' },
          `${formatBytes(item.size, t)} · ${formatDateTime(item.modifiedAt, locale) || t('detail.none')}`,
        );
      } else {
        description = h('span', { className: 'aa-row-desc-mono aa-mono' }, item.summary || t('detail.none'));
        meta = h(
          'span',
          { className: 'aa-row-meta-facts' },
          formatDateTime(item.updatedAt, locale) || t('detail.none'),
        );
      }

      let statusBadge = null;
      if (tab === 'skills') {
        if (!item.editable) statusBadge = h(Badge, { tone: 'muted' }, t('badge.readonly'));
      } else if (tab === 'mcp') {
        statusBadge = h(
          Badge,
          {
            tone: mcpStatusTone(item.status.state),
            title: item.status.error || mcpStatusLabel(t, item.status),
          },
          mcpStatusLabel(t, item.status),
        );
      }

      const actions = [];
      const canEdit = tab === 'mcp' ? true : item.editable;
      const canDelete = canEdit;
      if (canEdit) {
        actions.push(
          h(
            'button',
            {
              key: 'edit',
              type: 'button',
              className: 'aa-row-action',
              title: t('action.edit'),
              onClick: () => onEdit(item),
            },
            t('action.edit'),
          ),
        );
      }
      if (tab === 'mcp') {
        const switchLabel = t(item.enabled ? 'mcp.switch.disable' : 'mcp.switch.enable', { name: item.serverName });
        actions.push(
          togglePending
            ? h('span', { key: 'switch', className: 'aa-switch-pending', 'aria-busy': 'true' }, h(Spinner, { size: 11 }))
            : h(Switch, {
                key: 'switch',
                checked: item.enabled,
                label: switchLabel,
                onChange: () => onToggle(item),
              }),
        );
      }
      if (canDelete) {
        actions.push(
          h(
            'button',
            {
              key: 'delete',
              type: 'button',
              className: 'aa-row-action is-danger',
              title: t('action.delete'),
              onClick: () => onDelete(item),
            },
            t('action.delete'),
          ),
        );
      }

      return h(
        'div',
        {
          className: `aa-row${selected ? ' is-selected' : ''}`,
          role: 'button',
          tabIndex: 0,
          'aria-label': t('row.aria', { name: title }),
          'aria-pressed': Boolean(selected),
          onClick: () => onOpen(item),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onOpen(item);
            } else if (event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault();
              onSelectToggle(item);
            }
          },
        },
        h('span', { className: `aa-row-icon aa-row-icon-${tab}` }, h(KindGlyph, { tab, size: 16 })),
        h(
          'div',
          { className: 'aa-row-main' },
          h('div', { className: 'aa-row-titleline' }, h('span', { className: 'aa-row-name' }, title), badges),
          description ? h('div', { className: 'aa-row-desc' }, description) : null,
          h('div', { className: 'aa-row-meta' }, meta),
        ),
        h(
          'div',
          { className: 'aa-row-right' },
          statusBadge,
          h(
            'div',
            {
              className: 'aa-row-actions',
              'aria-label': t('row.actions'),
              onClick: (event) => event.stopPropagation(),
              onKeyDown: (event) => event.stopPropagation(),
            },
            actions,
          ),
        ),
      );
    }

    function Section({
      t,
      locale,
      tab,
      scope,
      items,
      workspace,
      workspaceLabel,
      homes,
      selectedKey,
      onOpen,
      onEdit,
      onDelete,
      onToggle,
      onSelectToggle,
      isTogglePending,
    }) {
      const title =
        scope === 'workspace'
          ? t('section.workspace', { name: workspaceLabel || baseName(workspace) || workspace || t('workspace.none') })
          : scope === 'user'
            ? t('section.user', { home: shortHomePath(homes) })
            : t('section.bundled');
      const titleTooltip =
        scope === 'workspace' ? workspace || undefined : scope === 'user' ? homes?.dshHome || undefined : undefined;
      return h(
        'section',
        { className: 'aa-group', 'aria-label': title },
        h(
          'div',
          { className: 'aa-group-head' },
          h('span', { className: 'aa-group-title', title: titleTooltip }, title),
          h('span', { className: 'aa-group-count' }, t('section.count', { count: items.length })),
        ),
        h(
          'div',
          { className: 'aa-rows' },
          items.map((item) =>
            h(Row, {
              key: rowKey(tab, item),
              t,
              locale,
              tab,
              item,
              selected: selectedKey === rowKey(tab, item),
              togglePending: typeof isTogglePending === 'function' ? Boolean(isTogglePending(item)) : false,
              onOpen,
              onEdit,
              onDelete,
              onToggle,
              onSelectToggle,
            }),
          ),
        ),
      );
    }

    function ExternalNote({ t, locale, external }) {
      const list = Array.isArray(external) ? external.filter(Boolean) : [];
      if (list.length === 0) return null;
      const names = list.map((entry) => entry.serverName || entry.entryId || '').filter(Boolean);
      return h(
        'div',
        { className: 'aa-note', title: names.join(', ') },
        h(Badge, { tone: 'muted' }, t('badge.external')),
        h('span', null, t('mcp.external.note', { count: formatNumber(list.length, locale) })),
        names.length > 0 ? h('span', { className: 'aa-note-list aa-mono' }, names.join(' · ')) : null,
      );
    }

    // -------------------------------------------------------------------------------------
    // Dialog shell (focus trap, Escape, backdrop click, focus restore)
    // -------------------------------------------------------------------------------------

    const DIALOG_STACK = [];
    let DIALOG_UID = 0;

    function Dialog({ title, subtitle, width, raised, onClose, children, footer }) {
      const uidRef = useRef(0);
      if (uidRef.current === 0) uidRef.current = ++DIALOG_UID;
      const titleId = `aa-dialog-title-${uidRef.current}`;
      const panelRef = useRef(null);
      const closeRef = useRef(onClose);
      closeRef.current = onClose;

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const entry = { uid: uidRef.current };
        DIALOG_STACK.push(entry);
        const previous = document.activeElement;
        const panel = panelRef.current;
        const focusables = () => {
          if (!panel) return [];
          const nodes = panel.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          );
          return Array.prototype.filter.call(
            nodes,
            (node) => node.offsetParent !== null || node === document.activeElement,
          );
        };
        let focusTarget = panel ? panel.querySelector('[data-autofocus="true"]') : null;
        if (!focusTarget) focusTarget = focusables()[0] || null;
        if (!focusTarget) focusTarget = panel;
        try {
          focusTarget?.focus?.({ preventScroll: true });
        } catch {
          // Focusing is best-effort.
        }
        const onKeyDown = (event) => {
          if (DIALOG_STACK[DIALOG_STACK.length - 1] !== entry) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeRef.current?.();
            return;
          }
          if (event.key !== 'Tab' || !panel) return;
          const items = focusables();
          if (items.length === 0) {
            event.preventDefault();
            try {
              panel.focus();
            } catch {
              // ignore
            }
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          const active = document.activeElement;
          if (event.shiftKey) {
            if (active === first || !panel.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else if (active === last || !panel.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('keydown', onKeyDown, true);
          const index = DIALOG_STACK.indexOf(entry);
          if (index >= 0) DIALOG_STACK.splice(index, 1);
          try {
            if (previous && previous.focus && previous.isConnected !== false) {
              previous.focus({ preventScroll: true });
            }
          } catch {
            // Focus restore is best-effort.
          }
        };
      }, []);

      return h(
        'div',
        {
          className: `aa-overlay${raised ? ' is-raised' : ''}`,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeRef.current?.();
          },
        },
        h(
          'div',
          {
            className: `aa-dialog${width === 'wide' ? ' is-wide' : width === 'narrow' ? ' is-narrow' : ''}`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            ref: panelRef,
            tabIndex: -1,
          },
          h(
            'div',
            { className: 'aa-dialog-head' },
            h('div', { className: 'aa-dialog-title', id: titleId }, title),
            subtitle ? h('div', { className: 'aa-dialog-sub' }, subtitle) : null,
          ),
          h('div', { className: 'aa-dialog-body' }, children),
          footer ? h('div', { className: 'aa-dialog-foot' }, footer) : null,
        ),
      );
    }

    function ConfirmDialog({ t, spec, onCancel, onConfirm }) {
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const handleConfirm = async () => {
        if (saving) return;
        setSaving(true);
        setError(null);
        try {
          await onConfirm();
        } catch (confirmError) {
          setError(errorInfo(confirmError));
        } finally {
          setSaving(false);
        }
      };
      return h(
        Dialog,
        {
          title: spec.title,
          width: 'narrow',
          raised: true,
          onClose: saving ? () => {} : onCancel,
          footer: [
            h(
              'button',
              {
                key: 'cancel',
                type: 'button',
                className: 'aa-btn',
                'data-autofocus': 'true',
                onClick: onCancel,
                disabled: saving,
              },
              spec.cancelLabel || t('action.cancel'),
            ),
            h(
              'button',
              {
                key: 'delete',
                type: 'button',
                className: 'aa-btn aa-btn-danger',
                onClick: handleConfirm,
                disabled: saving,
              },
              saving ? h(Spinner, { size: 11 }) : null,
              spec.confirmLabel || t('action.delete'),
            ),
          ],
        },
        h(
          'div',
          { className: 'aa-confirm' },
          h('p', { className: 'aa-confirm-text' }, spec.body),
          spec.path ? h('div', { className: 'aa-confirm-path aa-mono' }, spec.path) : null,
          error ? h(InlineError, { t, info: error }) : null,
        ),
      );
    }

    /**
     * Closing an editor with edits (Esc, the backdrop, Cancel) asks first instead of silently
     * dropping a long SKILL.md / AGENTS.md change.
     */
    function useDiscardGuard(t, dirty, onCancel) {
      const [asking, setAsking] = useState(false);
      const requestClose = useCallback(() => {
        if (dirty) setAsking(true);
        else onCancel();
      }, [dirty, onCancel]);
      const guard = asking
        ? h(ConfirmDialog, {
            t,
            spec: {
              title: t('discard.title'),
              body: t('discard.body'),
              confirmLabel: t('discard.confirm'),
              cancelLabel: t('discard.keep'),
            },
            onCancel: () => setAsking(false),
            onConfirm: async () => {
              setAsking(false);
              onCancel();
            },
          })
        : null;
      return { requestClose, guard };
    }

    // -------------------------------------------------------------------------------------
    // Detail dialog
    // -------------------------------------------------------------------------------------

    function MetaGrid({ children }) {
      return h('div', { className: 'aa-meta-grid' }, children);
    }

    function MetaItem({ label, children, wide, mono, title }) {
      return h(
        'div',
        { className: `aa-meta-item${wide ? ' is-wide' : ''}` },
        h('div', { className: 'aa-meta-label' }, label),
        h('div', { className: `aa-meta-value${mono ? ' aa-mono' : ''}`, title }, children),
      );
    }

    function FieldBlock({ label, extra, children }) {
      return h(
        'div',
        { className: 'aa-block' },
        h(
          'div',
          { className: 'aa-block-head' },
          h('div', { className: 'aa-block-label' }, label),
          extra || null,
        ),
        h('div', { className: 'aa-block-body' }, children),
      );
    }

    function KeyValueList({ t, entries, reveal, emptyText }) {
      const rows = Object.entries(entries || {});
      if (rows.length === 0) return h('div', { className: 'aa-muted' }, emptyText || t('detail.none'));
      return h(
        'div',
        { className: 'aa-kv-list' },
        rows.map(([key, value]) =>
          h(
            'div',
            { key, className: 'aa-kv' },
            h('span', { className: 'aa-kv-key aa-mono' }, key),
            h('span', { className: 'aa-kv-value aa-mono' }, reveal ? String(value) : '••••••'),
          ),
        ),
      );
    }

    function DetailDialog({ t, locale, dialog, onClose, onRetry, onEdit, onDelete, onToggle, isToggling, onTrust }) {
      const [showSecrets, setShowSecrets] = useState(false);
      const tab = dialog.tab;
      const target = dialog.target || {};
      const detail = dialog.detail || null;
      const entity = detail || target;
      const title = displayEntityName(tab, target, t);
      const exists = tab === 'instructions' ? Boolean(detail ? detail.exists : target.exists) : true;
      const editable = tab === 'mcp' ? true : Boolean(detail ? detail.editable : target.editable);
      const canDelete = tab === 'mcp' ? true : editable && (tab === 'skills' || exists);
      const canEdit = editable;

      const footer = [
        canDelete
          ? h(
              'button',
              {
                key: 'delete',
                type: 'button',
                className: 'aa-btn aa-btn-ghost-danger',
                onClick: () => onDelete(dialog.target),
              },
              t('action.delete'),
            )
          : null,
        h('div', { key: 'spacer', className: 'aa-foot-spacer' }),
        h('button', { key: 'close', type: 'button', className: 'aa-btn', onClick: onClose }, t('action.close')),
        canEdit
          ? h(
              'button',
              {
                key: 'edit',
                type: 'button',
                className: 'aa-btn aa-btn-primary',
                onClick: () => onEdit(),
              },
              tab === 'instructions' && !exists ? t('action.create') : t('action.edit'),
            )
          : null,
      ];

      const renderSkill = () => {
        const skill = detail || target;
        return h(
          'div',
          { className: 'aa-detail' },
          h(
            'div',
            { className: 'aa-detail-badges' },
            h(Badge, { tone: 'brand' }, t(scopeKey(skill.scope))),
            skill.source ? h(Badge, { tone: 'muted' }, skill.source) : null,
            !skill.editable ? h(Badge, { tone: 'muted' }, t('badge.readonly')) : null,
            skill.shadowed && skill.shadowed.length > 0
              ? h(Badge, { tone: 'warn' }, t('badge.shadowed', { count: skill.shadowed.length }))
              : null,
          ),
          h(
            MetaGrid,
            null,
            h(MetaItem, { label: t('detail.field.path'), wide: true, mono: true, title: skill.path || '' }, skill.path || t('detail.none')),
            skill.shadowed && skill.shadowed.length > 0
              ? h(
                  MetaItem,
                  { label: t('detail.field.shadowed'), wide: true },
                  h(
                    'div',
                    { className: 'aa-shadow-list' },
                    skill.shadowed.map((entry, index) =>
                      h(
                        'div',
                        { key: index, className: 'aa-mono' },
                        `${entry?.scope ? `${entry.scope} · ` : ''}${entry?.path || ''}`,
                      ),
                    ),
                  ),
                )
              : null,
          ),
          h(
            FieldBlock,
            { label: t('detail.field.description') },
            h('div', { className: 'aa-detail-text' }, skill.description || t('detail.none')),
          ),
          skill.whenToUse
            ? h(FieldBlock, { label: t('detail.field.whenToUse') }, h('div', { className: 'aa-detail-text' }, skill.whenToUse))
            : null,
          h(
            FieldBlock,
            { label: t('detail.section.content') },
            skill.body ? h('pre', { className: 'aa-pre' }, skill.body) : h('div', { className: 'aa-muted' }, t('detail.emptyBody')),
          ),
        );
      };

      const renderInstruction = () => {
        const instruction = detail || target;
        return h(
          'div',
          { className: 'aa-detail' },
          h(
            'div',
            { className: 'aa-detail-badges' },
            h(Badge, { tone: 'brand' }, t(scopeKey(instruction.scope))),
            h(Badge, { tone: exists ? 'ok' : 'warn' }, t(exists ? 'badge.exists' : 'badge.missing')),
          ),
          h(
            MetaGrid,
            null,
            h(MetaItem, { label: t('detail.field.size') }, formatBytes(instruction.size, t)),
            h(MetaItem, { label: t('detail.field.path'), wide: true, mono: true, title: instruction.path || '' }, instruction.path || t('detail.none')),
            h(MetaItem, { label: t('detail.field.modified') }, formatDateTime(instruction.modifiedAt, locale) || t('detail.none')),
          ),
          exists
            ? h(
                FieldBlock,
                { label: t('detail.section.content') },
                instruction.content
                  ? h('pre', { className: 'aa-pre is-tall' }, instruction.content)
                  : h('div', { className: 'aa-muted' }, t('detail.emptyBody')),
              )
            : h('div', { className: 'aa-note' }, h(IconAlert, { size: 12 }), h('span', null, t('detail.missingFile'))),
        );
      };

      const renderMcp = () => {
        const server = detail || target;
        const status = server.status || { state: 'unknown', tools: 0, error: null };
        const isHttp = server.transport === 'streamable-http';
        const envEntries = server.env || {};
        const headerEntries = server.headers || {};
        const hasSecrets = Object.keys(envEntries).length > 0 || Object.keys(headerEntries).length > 0;
        const toggleKey = `${server.scope}:${server.serverName}`;
        return h(
          'div',
          { className: 'aa-detail' },
          h(
            'div',
            { className: 'aa-detail-badges' },
            h(Badge, { tone: 'brand' }, t(scopeKey(server.scope))),
            h(Badge, { tone: 'muted' }, server.transport || t('detail.none')),
            h(
              Badge,
              { tone: mcpStatusTone(status.state), title: status.error || undefined },
              mcpStatusLabel(t, status),
            ),
          ),
          server.trusted === false
            ? h(
                'div',
                { className: 'aa-note aa-note-warn' },
                h(IconAlert, { size: 12 }),
                h('span', null, t('mcp.trust.note')),
                h(
                  'button',
                  { type: 'button', className: 'aa-btn aa-btn-sm', onClick: () => onTrust(server) },
                  t('mcp.trust.action'),
                ),
              )
            : null,
          h(
            MetaGrid,
            null,
            h(MetaItem, { label: t('detail.field.modified') }, formatDateTime(server.updatedAt, locale) || t('detail.none')),
            h(MetaItem, { label: t('detail.field.summary'), wide: true, mono: true }, server.summary || t('detail.none')),
          ),
          h(
            FieldBlock,
            {
              label: t('detail.section.config'),
              extra: hasSecrets
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'aa-link-btn',
                      'aria-pressed': showSecrets,
                      onClick: () => setShowSecrets((value) => !value),
                    },
                    t(showSecrets ? 'detail.secrets.hide' : 'detail.secrets.show'),
                  )
                : null,
            },
            isHttp
              ? h(
                  'div',
                  { className: 'aa-config' },
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.url')),
                    h('div', { className: 'aa-meta-value aa-mono', title: server.url || '' }, server.url || t('detail.none')),
                  ),
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.headers')),
                    h(KeyValueList, { t, entries: headerEntries, reveal: showSecrets }),
                  ),
                )
              : h(
                  'div',
                  { className: 'aa-config' },
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.command')),
                    h('div', { className: 'aa-meta-value aa-mono' }, server.command || t('detail.none')),
                  ),
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.args')),
                    h(
                      'div',
                      { className: 'aa-meta-value aa-mono' },
                      Array.isArray(server.args) && server.args.length > 0 ? server.args.join(' ') : t('detail.none'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.cwd')),
                    h('div', { className: 'aa-meta-value aa-mono' }, server.cwd || t('detail.none')),
                  ),
                  h(
                    'div',
                    { className: 'aa-config-row' },
                    h('div', { className: 'aa-meta-label' }, t('detail.field.env')),
                    h(KeyValueList, { t, entries: envEntries, reveal: showSecrets }),
                  ),
                ),
          ),
          h(
            'div',
            { className: 'aa-toggle-row' },
            h('div', { className: 'aa-meta-label' }, t('detail.field.enabled')),
            isToggling
              ? h('span', { className: 'aa-switch-pending', 'aria-busy': 'true' }, h(Spinner, { size: 11 }))
              : h(Switch, {
                  checked: server.enabled !== false,
                  label: t(server.enabled !== false ? 'mcp.switch.disable' : 'mcp.switch.enable', {
                    name: server.serverName,
                  }),
                  onChange: () => onToggle(server, toggleKey),
                }),
          ),
        );
      };

      let body;
      if (dialog.status === 'loading') {
        body = h(
          'div',
          { className: 'aa-dialog-loading' },
          Array.from({ length: 5 }, (_, index) => h('div', { key: index, className: 'aa-skeleton-line' })),
        );
      } else if (dialog.status === 'error') {
        body = h(InlineError, { t, info: dialog.error, onRetry });
      } else if (tab === 'skills') {
        body = renderSkill();
      } else if (tab === 'instructions') {
        body = renderInstruction();
      } else {
        body = renderMcp();
      }

      return h(
        Dialog,
        {
          title,
          subtitle: t('detail.breadcrumb', { section: t(TAB_LABEL_KEY[tab]), name: title }),
          width: tab === 'instructions' ? 'wide' : 'regular',
          onClose,
          footer,
        },
        body,
      );
    }

    // -------------------------------------------------------------------------------------
    // Editors
    // -------------------------------------------------------------------------------------

    function splitLines(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    }

    function parseKeyValueLines(text, separator) {
      const lines = String(text || '').split(/\r?\n/);
      const value = {};
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index].trim();
        if (!raw) continue;
        const at = raw.indexOf(separator);
        if (at <= 0) return { value: {}, error: { line: index + 1 } };
        const key = raw.slice(0, at).trim();
        if (!key) return { value: {}, error: { line: index + 1 } };
        value[key] = raw.slice(at + separator.length).trim();
      }
      return { value, error: null };
    }

    function keyValueText(entries, separator) {
      const rows = Object.entries(entries || {});
      return rows.map(([key, value]) => `${key}${separator}${String(value ?? '')}`).join('\n');
    }

    function Field({ label, htmlFor, hint, error, children }) {
      return h(
        'div',
        { className: 'aa-field' },
        h('label', { className: 'aa-label', htmlFor }, label),
        children,
        error
          ? h('div', { className: 'aa-field-error', role: 'alert' }, error)
          : hint
            ? h('div', { className: 'aa-hint' }, hint)
            : null,
      );
    }

    function FormFooter({ t, saving, canSave, onCancel, onSave, onDelete }) {
      return [
        onDelete
          ? h(
              'button',
              { key: 'delete', type: 'button', className: 'aa-btn aa-btn-ghost-danger', onClick: onDelete, disabled: saving },
              t('action.delete'),
            )
          : null,
        h('div', { key: 'spacer', className: 'aa-foot-spacer' }),
        h('button', { key: 'cancel', type: 'button', className: 'aa-btn', onClick: onCancel, disabled: saving }, t('action.cancel')),
        h(
          'button',
          { key: 'save', type: 'button', className: 'aa-btn aa-btn-primary', onClick: onSave, disabled: !canSave || saving },
          saving ? h(Spinner, { size: 11 }) : null,
          saving ? t('action.saving') : t('action.save'),
        ),
      ];
    }

    function EditorLoadingDialog({ t, title, onCancel }) {
      return h(
        Dialog,
        {
          title,
          subtitle: t('editor.loading'),
          width: 'wide',
          onClose: onCancel,
          footer: h('button', { type: 'button', className: 'aa-btn', onClick: onCancel }, t('action.cancel')),
        },
        h(
          'div',
          { className: 'aa-dialog-loading', 'aria-busy': 'true' },
          Array.from({ length: 5 }, (_, index) => h('div', { key: index, className: 'aa-skeleton-line' })),
        ),
      );
    }

    function EditorErrorDialog({ t, title, error, onCancel, onRetry }) {
      return h(
        Dialog,
        {
          title,
          subtitle: t('editor.loadFailed'),
          width: 'wide',
          onClose: onCancel,
          footer: [
            h('div', { key: 'spacer', className: 'aa-foot-spacer' }),
            h('button', { key: 'cancel', type: 'button', className: 'aa-btn', onClick: onCancel }, t('action.close')),
            onRetry
              ? h('button', { key: 'retry', type: 'button', className: 'aa-btn aa-btn-primary', onClick: onRetry }, t('action.retry'))
              : null,
          ],
        },
        h(InlineError, { t, info: error }),
      );
    }

    function ScopeSelector({ t, value, onChange, disabledWorkspace }) {
      return h(
        'div',
        { className: 'aa-field' },
        h('div', { className: 'aa-label' }, t('editor.scope')),
        h(Segmented, {
          value,
          ariaLabel: t('editor.scope'),
          onChange,
          options: [
            { value: 'workspace', label: t('scope.workspace'), disabled: disabledWorkspace },
            { value: 'user', label: t('scope.user') },
          ],
        }),
      );
    }

    // ----- Skill editor ---------------------------------------------------------------

    function SkillEditor({ t, locale, dialog, workspace, homes, onCancel, onRetry, onSubmit }) {
      const title = t(dialog.mode === 'create' ? 'editor.skill.createTitle' : 'editor.skill.editTitle');
      if (dialog.status === 'loading') return h(EditorLoadingDialog, { t, title, onCancel });
      if (dialog.status === 'error') return h(EditorErrorDialog, { t, title, error: dialog.error, onCancel, onRetry });
      return h(SkillForm, { t, locale, dialog, workspace, homes, onCancel, onSubmit });
    }

    function SkillForm({ t, dialog, workspace, homes, onCancel, onSubmit }) {
      const mode = dialog.mode;
      const target = dialog.target || null;
      const initial = dialog.initial || null;
      const [scope, setScope] = useState(mode === 'create' ? (workspace ? 'workspace' : 'user') : target?.scope || 'workspace');
      const [name, setName] = useState(mode === 'create' ? '' : String(initial?.name || target?.name || ''));
      // A stored description may span lines (YAML block scalar); the field and the API take one line.
      const initialDescription = String(initial?.description || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
      const [description, setDescription] = useState(initialDescription);
      const [whenToUse, setWhenToUse] = useState(String(initial?.whenToUse || ''));
      const [body, setBody] = useState(String(initial?.body || ''));
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const uidRef = useRef(0);
      if (uidRef.current === 0) uidRef.current = ++FORM_UID;
      const uid = uidRef.current;

      const trimmedName = name.trim();
      const nameError =
        mode !== 'create'
          ? ''
          : !trimmedName
            ? t('editor.skill.nameRequired')
            : SKILL_NAME_RE.test(trimmedName)
              ? ''
              : t('editor.skill.nameInvalid');
      const descriptionTrimmed = description.trim();
      const descriptionError = !descriptionTrimmed
        ? t('editor.skill.descriptionRequired')
        : description.length > 1024 || /[\r\n]/.test(description)
          ? t('editor.skill.descriptionInvalid')
          : '';
      const dirty =
        mode === 'create'
          ? Boolean(trimmedName || descriptionTrimmed || whenToUse.trim() || body)
          : description !== initialDescription ||
            whenToUse !== String(initial?.whenToUse || '') ||
            body !== String(initial?.body || '');
      const canSave = !nameError && !descriptionError && (mode === 'create' ? dirty : true);
      const { requestClose, guard } = useDiscardGuard(t, dirty && !saving, onCancel);

      const root = scope === 'user'
        ? displayJoin(shortHomePath(homes), 'skills')
        : workspace ? displayJoin(workspace, '.dsh', 'skills') : `${t('workspace.none')}/.dsh/skills`;

      const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        setError(null);
        try {
          await onSubmit({
            op: mode === 'create' ? 'create' : 'update',
            scope,
            name: mode === 'create' ? trimmedName : String(target?.name || trimmedName),
            description: descriptionTrimmed,
            whenToUse: whenToUse.trim() ? whenToUse.trim() : null,
            body,
          });
        } catch (saveError) {
          setError(errorInfo(saveError));
        } finally {
          setSaving(false);
        }
      };

      return h(
        Dialog,
        {
          title: t(mode === 'create' ? 'editor.skill.createTitle' : 'editor.skill.editTitle'),
          subtitle: mode === 'create' ? undefined : String(target?.name || ''),
          width: 'wide',
          onClose: saving ? () => {} : requestClose,
          footer: h(FormFooter, { t, saving, canSave, onCancel: requestClose, onSave: handleSave }),
        },
        guard,
        h(
          'div',
          { className: 'aa-form' },
          error ? h(InlineError, { t, info: error }) : null,
          h(
            'div',
            { className: 'aa-form-row' },
            h(
              Field,
              {
                label: t('editor.skill.name'),
                htmlFor: `aa-skill-name-${uid}`,
                hint: t('editor.skill.nameHint'),
                error: nameError,
              },
              h('input', {
                id: `aa-skill-name-${uid}`,
                className: 'aa-input aa-mono',
                type: 'text',
                value: name,
                disabled: mode !== 'create',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: t('editor.skill.namePlaceholder'),
                onChange: (event) => setName(event.target.value),
              }),
            ),
            mode === 'create'
              ? h(ScopeSelector, {
                  t,
                  value: scope,
                  onChange: setScope,
                  disabledWorkspace: !workspace,
                })
              : h(
                  'div',
                  { className: 'aa-field' },
                  h('div', { className: 'aa-label' }, t('editor.skill.scope')),
                  h('div', { className: 'aa-scope-line' }, h(Badge, { tone: 'brand' }, t(scopeKey(scope)))),
                ),
          ),
          h(
            Field,
            {
              label: t('editor.skill.description'),
              htmlFor: `aa-skill-desc-${uid}`,
              hint: t('editor.skill.descriptionHint'),
              error: descriptionError && description.length > 0 ? descriptionError : null,
            },
            h('textarea', {
              id: `aa-skill-desc-${uid}`,
              className: 'aa-textarea',
              rows: 2,
              value: description,
              onChange: (event) => setDescription(event.target.value),
            }),
          ),
          h(
            Field,
            {
              label: t('editor.skill.whenToUse'),
              htmlFor: `aa-skill-when-${uid}`,
              hint: t('editor.skill.whenToUseHint'),
            },
            h('input', {
              id: `aa-skill-when-${uid}`,
              className: 'aa-input',
              type: 'text',
              value: whenToUse,
              onChange: (event) => setWhenToUse(event.target.value),
            }),
          ),
          h(
            Field,
            {
              label: t('editor.skill.body'),
              htmlFor: `aa-skill-body-${uid}`,
              hint: t('editor.skill.bodyHint'),
            },
            h('textarea', {
              id: `aa-skill-body-${uid}`,
              className: 'aa-textarea aa-mono aa-textarea-tall',
              rows: 12,
              value: body,
              onChange: (event) => setBody(event.target.value),
            }),
          ),
          h('div', { className: 'aa-note' }, t('editor.skill.pathNote', { root })),
        ),
      );
    }

    // ----- Instruction editor ---------------------------------------------------------

    function InstructionEditor({ t, dialog, workspace, candidates, onCancel, onRetry, onSubmit, onDelete }) {
      const titleKey =
        dialog.mode === 'create'
          ? 'editor.instruction.createTitle'
          : dialog.target && !(dialog.initial ? dialog.initial.exists : dialog.target.exists)
            ? 'editor.instruction.createMissingTitle'
            : 'editor.instruction.editTitle';
      const title = t(titleKey);
      if (dialog.status === 'loading') return h(EditorLoadingDialog, { t, title, onCancel });
      if (dialog.status === 'error') return h(EditorErrorDialog, { t, title, error: dialog.error, onCancel, onRetry });
      return h(InstructionForm, { t, dialog, workspace, candidates, onCancel, onSubmit, onDelete });
    }

    function InstructionForm({ t, dialog, workspace, candidates, onCancel, onSubmit, onDelete }) {
      const mode = dialog.mode;
      const target = dialog.target || null;
      const initial = dialog.initial || null;
      const missingCandidates = useMemo(
        () => (Array.isArray(candidates) ? candidates.filter((candidate) => !candidate.exists) : []),
        [candidates],
      );
      const [filePath, setFilePath] = useState(
        mode === 'create' ? String(missingCandidates[0]?.path || '') : String(target?.path || initial?.path || ''),
      );
      const [content, setContent] = useState(String(initial?.content || ''));
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const uidRef = useRef(0);
      if (uidRef.current === 0) uidRef.current = ++FORM_UID;
      const uid = uidRef.current;

      const chosen = mode === 'create'
        ? missingCandidates.find((candidate) => candidate.path === filePath) || null
        : target || initial || null;
      const scope = String(chosen?.scope || (mode === 'create' ? 'workspace' : 'workspace'));
      const exists = mode === 'create' ? false : Boolean(initial ? initial.exists : target?.exists);
      const canSave = Boolean(filePath) && !saving && (mode !== 'create' || missingCandidates.length > 0);
      const dirty = content !== String(initial?.content || '');
      const { requestClose, guard } = useDiscardGuard(t, dirty && !saving, onCancel);

      const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        setError(null);
        try {
          await onSubmit({ op: 'write', scope, path: filePath, content });
        } catch (saveError) {
          setError(errorInfo(saveError));
        } finally {
          setSaving(false);
        }
      };

      return h(
        Dialog,
        {
          title: t(
            mode === 'create'
              ? 'editor.instruction.createTitle'
              : exists
                ? 'editor.instruction.editTitle'
                : 'editor.instruction.createMissingTitle',
          ),
          subtitle: chosen?.displayPath || chosen?.label || target?.displayPath || target?.label || '',
          width: 'wide',
          onClose: saving ? () => {} : requestClose,
          footer: h(FormFooter, {
            t,
            saving,
            canSave,
            onCancel: requestClose,
            onSave: handleSave,
            onDelete: mode === 'edit' && exists && (target?.editable !== false || initial?.editable !== false)
              ? () => onDelete(target || initial)
              : null,
          }),
        },
        guard,
        h(
          'div',
          { className: 'aa-form' },
          error ? h(InlineError, { t, info: error }) : null,
          mode === 'create'
            ? h(
                Field,
                { label: t('editor.instruction.file'), htmlFor: `aa-instruction-file-${uid}`, hint: t('editor.instruction.fileHint') },
                missingCandidates.length > 0
                  ? h(
                      'select',
                      {
                        id: `aa-instruction-file-${uid}`,
                        className: 'aa-select aa-select-block',
                        value: filePath,
                        onChange: (event) => setFilePath(event.target.value),
                      },
                      missingCandidates.map((candidate) =>
                        h(
                          'option',
                          { key: candidate.path, value: candidate.path },
                          `${t(scopeKey(candidate.scope))} · ${candidate.label || candidate.file || baseName(candidate.path)}`,
                        ),
                      ),
                    )
                  : h(
                      'div',
                      { className: 'aa-note' },
                      t(
                        Array.isArray(candidates) && candidates.length > 0
                          ? 'editor.instruction.none'
                          : 'editor.instruction.noCandidates',
                      ),
                    ),
              )
            : h(
                'div',
                { className: 'aa-field' },
                h('div', { className: 'aa-label' }, t('editor.instruction.file')),
                h(
                  'div',
                  { className: 'aa-fixed-file' },
                  h('span', { className: 'aa-mono', title: chosen?.path || '' }, chosen?.displayPath || chosen?.label || filePath),
                  h(Badge, { tone: exists ? 'ok' : 'warn' }, t(exists ? 'badge.exists' : 'badge.missing')),
                ),
              ),
          !exists && mode === 'edit' ? h('div', { className: 'aa-note' }, t('editor.instruction.missingHint')) : null,
          h(
            Field,
            {
              label: t('editor.instruction.content'),
              htmlFor: `aa-instruction-content-${uid}`,
              hint: t('editor.instruction.contentHint'),
            },
            h('textarea', {
              id: `aa-instruction-content-${uid}`,
              className: 'aa-textarea aa-mono aa-textarea-tall',
              rows: 14,
              value: content,
              onChange: (event) => setContent(event.target.value),
            }),
          ),
        ),
      );
    }

    // ----- MCP editor -----------------------------------------------------------------

    function McpEditor({ t, locale, dialog, workspace, homes, onCancel, onRetry, onSubmit }) {
      const title = t(dialog.mode === 'create' ? 'editor.mcp.createTitle' : 'editor.mcp.editTitle');
      if (dialog.status === 'loading') return h(EditorLoadingDialog, { t, title, onCancel });
      if (dialog.status === 'error') return h(EditorErrorDialog, { t, title, error: dialog.error, onCancel, onRetry });
      return h(McpForm, { t, dialog, workspace, homes, onCancel, onSubmit });
    }

    function McpForm({ t, dialog, workspace, homes, onCancel, onSubmit }) {
      const mode = dialog.mode;
      const target = dialog.target || null;
      const initial = dialog.initial || null;
      const [serverName, setServerName] = useState(mode === 'create' ? '' : String(initial?.serverName || target?.serverName || ''));
      const [scope, setScope] = useState(mode === 'create' ? (workspace ? 'workspace' : 'user') : target?.scope || 'workspace');
      const [transport, setTransport] = useState(initial?.transport === 'streamable-http' ? 'streamable-http' : 'stdio');
      const [command, setCommand] = useState(String(initial?.command || ''));
      const [argsText, setArgsText] = useState(Array.isArray(initial?.args) ? initial.args.join('\n') : '');
      const [cwd, setCwd] = useState(String(initial?.cwd || ''));
      const [envText, setEnvText] = useState(keyValueText(initial?.env, '='));
      const [url, setUrl] = useState(String(initial?.url || ''));
      const [headersText, setHeadersText] = useState(keyValueText(initial?.headers, ': '));
      const [enabled, setEnabled] = useState(initial ? initial.enabled !== false : true);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);
      const uidRef = useRef(0);
      if (uidRef.current === 0) uidRef.current = ++FORM_UID;
      const uid = uidRef.current;

      const trimmedName = serverName.trim();
      const nameError =
        mode !== 'create'
          ? ''
          : !trimmedName
            ? t('editor.mcp.nameRequired')
            : MCP_NAME_RE.test(trimmedName)
              ? ''
              : t('editor.mcp.nameInvalid');
      const isHttp = transport === 'streamable-http';
      const commandError = !isHttp && !command.trim() ? t('editor.mcp.commandRequired') : '';
      const urlError = isHttp && !/^https?:\/\/\S+$/i.test(url.trim()) ? t('editor.mcp.urlRequired') : '';
      const envParsed = parseKeyValueLines(envText, '=');
      const headersParsed = parseKeyValueLines(headersText, ':');
      const envError = !isHttp && envParsed.error ? t('editor.mcp.invalidEnv', { line: envParsed.error.line }) : '';
      const headersError = isHttp && headersParsed.error ? t('editor.mcp.invalidHeader', { line: headersParsed.error.line }) : '';
      const canSave = !nameError && !commandError && !urlError && !envError && !headersError;
      // A workspace store lives in the repository folder and is easily committed; env values and
      // headers are where tokens go.
      const workspaceSecrets = scope === 'workspace'
        && (isHttp ? Object.keys(headersParsed.value || {}).length > 0 : Object.keys(envParsed.value || {}).length > 0);
      // npm/npx/pnpm/yarn are .cmd shims on Windows; spawning the bare name without a shell can fail.
      const windowsShim = !isHttp && isWindowsPlatform() && /^(npx|npm|pnpm|yarn|bunx)$/i.test(command.trim());
      const formKey = JSON.stringify([serverName, scope, transport, command, argsText, cwd, envText, url, headersText, enabled]);
      const initialKey = useRef(formKey);
      const dirty = formKey !== initialKey.current;
      const { requestClose, guard } = useDiscardGuard(t, dirty && !saving, onCancel);
      const userStorePath = displayJoin(shortHomePath(homes), 'agent-assets', 'mcp.json');
      const workspaceStorePath = workspace
        ? displayJoin(workspace, '.dsh', 'agent-assets', 'mcp.json')
        : `${t('workspace.none')}/.dsh/agent-assets/mcp.json`;

      const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        setError(null);
        try {
          const resolvedName = mode === 'create' ? trimmedName : String(target?.serverName || trimmedName);
          const server = {
            serverName: resolvedName,
            scope,
            transport,
            enabled,
            toolCallTimeoutMs: initial?.toolCallTimeoutMs ?? null,
            ...(isHttp
              ? { url: url.trim(), headers: headersParsed.value }
              : {
                  command: command.trim(),
                  args: splitLines(argsText),
                  cwd: cwd.trim(),
                  env: envParsed.value,
                }),
          };
          await onSubmit({ op: mode === 'create' ? 'create' : 'update', scope, server });
        } catch (saveError) {
          setError(errorInfo(saveError));
        } finally {
          setSaving(false);
        }
      };

      return h(
        Dialog,
        {
          title: t(mode === 'create' ? 'editor.mcp.createTitle' : 'editor.mcp.editTitle'),
          subtitle: mode === 'create' ? t('editor.mcp.scopeHint') : String(target?.serverName || ''),
          width: 'wide',
          onClose: saving ? () => {} : requestClose,
          footer: h(FormFooter, { t, saving, canSave, onCancel: requestClose, onSave: handleSave }),
        },
        guard,
        h(
          'div',
          { className: 'aa-form' },
          error ? h(InlineError, { t, info: error }) : null,
          h(
            'div',
            { className: 'aa-form-row' },
            h(
              Field,
              {
                label: t('editor.mcp.name'),
                htmlFor: `aa-mcp-name-${uid}`,
                hint: t('editor.mcp.nameHint'),
                error: nameError,
              },
              h('input', {
                id: `aa-mcp-name-${uid}`,
                className: 'aa-input aa-mono',
                type: 'text',
                value: serverName,
                disabled: mode !== 'create',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: t('editor.mcp.namePlaceholder'),
                onChange: (event) => setServerName(event.target.value),
              }),
            ),
            mode === 'create'
              ? h(ScopeSelector, { t, value: scope, onChange: setScope, disabledWorkspace: !workspace })
              : h(
                  'div',
                  { className: 'aa-field' },
                  h('div', { className: 'aa-label' }, t('editor.mcp.scope')),
                  h('div', { className: 'aa-scope-line' }, h(Badge, { tone: 'brand' }, t(scopeKey(scope)))),
                ),
          ),
          h(
            'div',
            { className: 'aa-field' },
            h('div', { className: 'aa-label' }, t('editor.mcp.transport')),
            h(Segmented, {
              value: transport,
              ariaLabel: t('editor.mcp.transport'),
              onChange: setTransport,
              options: [
                { value: 'stdio', label: t('editor.mcp.transport.stdio') },
                { value: 'streamable-http', label: t('editor.mcp.transport.http') },
              ],
            }),
          ),
          isHttp
            ? h(
                'div',
                { className: 'aa-form' },
                h(
                  Field,
                  { label: t('editor.mcp.url'), htmlFor: `aa-mcp-url-${uid}`, error: urlError },
                  h('input', {
                    id: `aa-mcp-url-${uid}`,
                    className: 'aa-input aa-mono',
                    type: 'text',
                    value: url,
                    spellCheck: false,
                    placeholder: t('editor.mcp.urlPlaceholder'),
                    onChange: (event) => setUrl(event.target.value),
                  }),
                ),
                h(
                  Field,
                  {
                    label: t('editor.mcp.headers'),
                    htmlFor: `aa-mcp-headers-${uid}`,
                    hint: t('editor.mcp.headersHint'),
                    error: headersError,
                  },
                  h('textarea', {
                    id: `aa-mcp-headers-${uid}`,
                    className: 'aa-textarea aa-mono',
                    rows: 4,
                    value: headersText,
                    placeholder: headersParsed.error ? '' : t('editor.mcp.headersPlaceholder'),
                    onChange: (event) => setHeadersText(event.target.value),
                  }),
                ),
              )
            : h(
                'div',
                { className: 'aa-form' },
                h(
                  'div',
                  { className: 'aa-form-row' },
                  h(
                    Field,
                    { label: t('editor.mcp.command'), htmlFor: `aa-mcp-command-${uid}`, error: commandError },
                    h('input', {
                      id: `aa-mcp-command-${uid}`,
                      className: 'aa-input aa-mono',
                      type: 'text',
                      value: command,
                      spellCheck: false,
                      placeholder: t('editor.mcp.commandPlaceholder'),
                      onChange: (event) => setCommand(event.target.value),
                    }),
                  ),
                  h(
                    Field,
                    { label: t('editor.mcp.cwd'), htmlFor: `aa-mcp-cwd-${uid}` },
                    h('input', {
                      id: `aa-mcp-cwd-${uid}`,
                      className: 'aa-input aa-mono',
                      type: 'text',
                      value: cwd,
                      spellCheck: false,
                      placeholder: t('editor.mcp.cwdPlaceholder'),
                      onChange: (event) => setCwd(event.target.value),
                    }),
                  ),
                ),
                h(
                  Field,
                  { label: t('editor.mcp.args'), htmlFor: `aa-mcp-args-${uid}`, hint: t('editor.mcp.argsHint') },
                  h('textarea', {
                    id: `aa-mcp-args-${uid}`,
                    className: 'aa-textarea aa-mono',
                    rows: 4,
                    value: argsText,
                    onChange: (event) => setArgsText(event.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: t('editor.mcp.env'), htmlFor: `aa-mcp-env-${uid}`, hint: t('editor.mcp.envHint'), error: envError },
                  h('textarea', {
                    id: `aa-mcp-env-${uid}`,
                    className: 'aa-textarea aa-mono',
                    rows: 4,
                    value: envText,
                    onChange: (event) => setEnvText(event.target.value),
                  }),
                ),
              ),
          h(
            'div',
            { className: 'aa-toggle-row' },
            h('div', { className: 'aa-label' }, t('editor.mcp.enabled')),
            h(Switch, {
              checked: enabled,
              label: t('editor.mcp.enabled'),
              onChange: setEnabled,
            }),
          ),
          h(
            'div',
            { className: 'aa-note aa-note-warn' },
            h(IconAlert, { size: 12 }),
            h('span', null, t('editor.mcp.storeWarning', { userPath: userStorePath, workspacePath: workspaceStorePath })),
          ),
          workspaceSecrets
            ? h(
                'div',
                { className: 'aa-note aa-note-warn', role: 'status' },
                h(IconAlert, { size: 12 }),
                h('span', null, t('editor.mcp.workspaceSecrets', { path: workspaceStorePath })),
              )
            : null,
          windowsShim
            ? h('div', { className: 'aa-note' }, h('span', null, t('editor.mcp.windowsShim', { command: command.trim() })))
            : null,
          scope === 'workspace' ? h('div', { className: 'aa-note' }, h('span', null, t('editor.mcp.sessionScoped'))) : null,
        ),
      );
    }

    // -------------------------------------------------------------------------------------
    // Page
    // -------------------------------------------------------------------------------------

    let FORM_UID = 0;

    // ----- Skill import ---------------------------------------------------------------

    function ImportSkillDialog({ t, workspace, pickDirectory, onCancel, onImported, pushToast }) {
      const [source, setSource] = useState('');
      const [scope, setScope] = useState('user');
      const [scan, setScan] = useState(null);
      const [scanning, setScanning] = useState(false);
      const [importing, setImporting] = useState(false);
      const [error, setError] = useState(null);
      const [selected, setSelected] = useState(() => new Set());
      const [overwrite, setOverwrite] = useState(false);
      const scanKey = `${source.trim()}|${scope}|${workspace}`;
      const fresh = scan !== null && scan.key === scanKey;

      const runScan = async (value = source) => {
        const trimmed = String(value || '').trim();
        if (trimmed === '' || scanning) return;
        setScanning(true);
        setError(null);
        try {
          const payload = await requestJson('/skills/import', {
            method: 'POST',
            body: withWorkspace({ scope, source: trimmed, dryRun: true }, workspace),
          });
          const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
          setScan({ key: `${trimmed}|${scope}|${workspace}`, ...payload, candidates });
          setSelected(new Set(candidates.filter((item) => !item.error && !item.conflict).map((item) => item.name)));
        } catch (caught) {
          setScan(null);
          setError(describeApiError(t, errorInfo(caught)));
        } finally {
          setScanning(false);
        }
      };

      const browse = async () => {
        if (typeof pickDirectory !== 'function') return;
        try {
          const picked = await pickDirectory();
          if (typeof picked === 'string' && picked !== '') {
            setSource(picked);
            runScan(picked);
          }
        } catch (caught) {
          setError(String(caught?.message || caught));
        }
      };

      const candidates = fresh ? scan.candidates : [];
      const importable = candidates.filter((item) => !item.error && (!item.conflict || overwrite));
      const chosen = importable.filter((item) => selected.has(item.name));
      const toggle = (name) =>
        setSelected((previous) => {
          const next = new Set(previous);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
      const allChosen = importable.length > 0 && chosen.length === importable.length;

      const submit = async () => {
        if (!fresh || chosen.length === 0 || importing) return;
        setImporting(true);
        setError(null);
        try {
          const payload = await requestJson('/skills/import', {
            method: 'POST',
            body: withWorkspace(
              { scope, source: source.trim(), overwrite, names: chosen.map((item) => item.name) },
              workspace,
            ),
          });
          const imported = Array.isArray(payload.imported) ? payload.imported : [];
          const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
          pushToast({
            kind: skipped.length > 0 ? 'error' : 'success',
            message: skipped.length > 0
              ? t('toast.skill.importPartial', { n: imported.length, m: skipped.length })
              : t('toast.skill.imported', { n: imported.length }),
            detail: skipped.length > 0 ? skipped.map((item) => `${item.name}: ${item.reason}`).join('；') : undefined,
          });
          onImported(imported.length);
        } catch (caught) {
          setError(describeApiError(t, errorInfo(caught)));
        } finally {
          setImporting(false);
        }
      };

      const footer = [
        h('div', { key: 'spacer', className: 'aa-foot-spacer' }),
        h('button', { key: 'cancel', type: 'button', className: 'aa-btn', onClick: onCancel, disabled: importing }, t('action.cancel')),
        h(
          'button',
          {
            key: 'go',
            type: 'button',
            className: 'aa-btn aa-btn-primary',
            onClick: submit,
            disabled: !fresh || chosen.length === 0 || importing,
          },
          importing ? h(Spinner, { size: 11 }) : null,
          importing ? t('import.importing') : t('import.submit', { n: chosen.length }),
        ),
      ];

      return h(
        Dialog,
        { title: t('import.title'), subtitle: t('import.subtitle'), width: 720, onClose: importing ? () => {} : onCancel, footer },
        h(
          'div',
          { className: 'aa-form' },
          h(
            Field,
            { label: t('import.source'), htmlFor: 'aa-import-source', hint: t('import.hint') },
            h(
              'div',
              { className: 'aa-import-row' },
              h('input', {
                id: 'aa-import-source',
                className: 'aa-input aa-mono',
                value: source,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: t('import.sourcePlaceholder'),
                'data-autofocus': 'true',
                onChange: (event) => setSource(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    runScan();
                  }
                },
              }),
              typeof pickDirectory === 'function'
                ? h('button', { type: 'button', className: 'aa-btn', onClick: browse, disabled: scanning }, t('import.browse'))
                : null,
              h(
                'button',
                { type: 'button', className: 'aa-btn', onClick: () => runScan(), disabled: scanning || source.trim() === '' },
                scanning ? h(Spinner, { size: 11 }) : null,
                scanning ? t('import.scanning') : t('import.scan'),
              ),
            ),
          ),
          h(ScopeSelector, { t, value: scope, onChange: setScope, disabledWorkspace: !workspace }),
          error ? h('div', { className: 'aa-field-error', role: 'alert' }, error) : null,
          scan !== null && !fresh ? h('div', { className: 'aa-hint' }, t('import.rescan')) : null,
          fresh
            ? h(
                'div',
                { className: 'aa-import-result' },
                h(
                  'div',
                  { className: 'aa-import-head' },
                  h(
                    'label',
                    { className: 'aa-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: allChosen,
                      disabled: importable.length === 0,
                      onChange: () => setSelected(allChosen ? new Set() : new Set(importable.map((item) => item.name))),
                    }),
                    h('span', null, candidates.length === 0 ? t('import.none') : t('import.found', { n: candidates.length })),
                  ),
                  h('span', { className: 'aa-hint aa-ellipsis', title: scan.target }, t('import.target', { path: scan.target })),
                ),
                candidates.length > 0
                  ? h(
                      'div',
                      { className: 'aa-import-list' },
                      candidates.map((item) => {
                        const blocked = Boolean(item.error) || (item.conflict && !overwrite);
                        return h(
                          'label',
                          { key: `${item.name}|${item.source}`, className: `aa-import-item${blocked ? ' is-blocked' : ''}` },
                          h('input', {
                            type: 'checkbox',
                            checked: !blocked && selected.has(item.name),
                            disabled: blocked,
                            onChange: () => toggle(item.name),
                          }),
                          h(
                            'span',
                            { className: 'aa-import-main' },
                            h(
                              'span',
                              { className: 'aa-import-title' },
                              h('span', { className: 'aa-import-name' }, item.name),
                              item.conflict ? h(Badge, { tone: 'warn', title: item.conflict.path }, t('import.conflict')) : null,
                              item.error ? h(Badge, { tone: 'error' }, t('import.invalid')) : null,
                            ),
                            item.description ? h('span', { className: 'aa-import-desc' }, item.description) : null,
                            h(
                              'span',
                              { className: 'aa-import-meta aa-mono', title: item.source },
                              `${t('import.files', { files: item.files, size: formatBytes(item.bytes, t) })} · ${item.source}`,
                            ),
                            item.error || item.warning
                              ? h('span', { className: item.error ? 'aa-field-error' : 'aa-hint' }, item.error || item.warning)
                              : null,
                          ),
                        );
                      }),
                    )
                  : null,
                candidates.some((item) => item.conflict)
                  ? h(
                      'label',
                      { className: 'aa-check aa-import-overwrite' },
                      h('input', { type: 'checkbox', checked: overwrite, onChange: (event) => {
                        const next = event.target.checked;
                        setOverwrite(next);
                        if (next) {
                          setSelected((previous) => {
                            const merged = new Set(previous);
                            for (const item of candidates) if (item.conflict && !item.error) merged.add(item.name);
                            return merged;
                          });
                        }
                      } }),
                      h('span', null, t('import.overwrite')),
                      h('span', { className: 'aa-hint' }, t('import.overwriteHint')),
                    )
                  : null,
              )
            : null,
        ),
      );
    }

    function withWorkspace(body, workspace) {
      return workspace ? { ...body, workspace } : body;
    }

    function buildConfirmSpec(t, tab, target) {
      const name = displayEntityName(tab, target, t);
      const path = target?.path || '';
      return {
        title: t(
          tab === 'skills'
            ? 'confirm.skill.title'
            : tab === 'instructions'
              ? 'confirm.instruction.title'
              : 'confirm.mcp.title',
        ),
        body: path ? t('confirm.body', { name, path }) : t('confirm.bodyNoPath', { name }),
        path,
      };
    }

    function AgentAssetsPage({ t, subscribeLocale, initialState, useSessions, pickDirectory }) {
      useLocaleTick(subscribeLocale);
      const seed = initialState || null;

      const [bootstrap, setBootstrap] = useState(seed?.bootstrap ?? null);
      const [bootState, setBootState] = useState(seed?.bootstrap ? 'ready' : 'loading');
      const [bootError, setBootError] = useState(null);
      const [workspaceChoice, setWorkspaceChoice] = useState(seed?.workspace ?? '');
      const [activeTab, setActiveTab] = useState(TAB_ORDER.includes(seed?.activeTab) ? seed.activeTab : 'skills');
      const [scopeFilter, setScopeFilter] = useState(seed?.scopeFilter || 'all');
      const [query, setQuery] = useState(seed?.query || '');
      const [data, setData] = useState(seed?.data || { skills: null, instructions: null, mcp: null });
      const [views, setViews] = useState(seed?.views || {});
      const [dialog, setDialog] = useState(seed?.dialog || null);
      const [confirm, setConfirm] = useState(seed?.confirm || null);
      const [toasts, setToasts] = useState(Array.isArray(seed?.toasts) ? seed.toasts : []);
      const [selectedKey, setSelectedKey] = useState('');
      const [toggling, setToggling] = useState({});
      const [rootRef, rootSize] = useElementSize();
      const contentRef = useRef(null);

      // Preferred scope: the active session workspace wins over the Host process cwd default.
      const useSessionsSafe = typeof useSessions === 'function' ? useSessions : noopUseSessions;
      const sessionCwd = useSessionsSafe(selectSessionCwd);
      const preferredWs = useMemo(() => preferredWorkspace(bootstrap, sessionCwd), [bootstrap, sessionCwd]);
      const [importOpen, setImportOpen] = useState(false);
      // The preferred workspace follows the session list, which can reorder while a dialog is open.
      // An open editor, confirmation or import keeps the workspace it was opened in, so a save can
      // never land in another workspace's same-named skill, file or server.
      const liveWs = workspaceChoice || preferredWs || '';
      const frozenWsRef = useRef(liveWs);
      const modalOpen = Boolean(dialog || confirm || importOpen);
      if (!modalOpen || frozenWsRef.current === '') frozenWsRef.current = liveWs;
      const wsPath = frozenWsRef.current;

      // Latest-value refs: async callbacks must never read a stale render closure.
      const mountedRef = useRef(false);
      const bootstrapRef = useRef(bootstrap);
      bootstrapRef.current = bootstrap;
      const workspaceRef = useRef(wsPath);
      workspaceRef.current = wsPath;
      const activeTabRef = useRef(activeTab);
      activeTabRef.current = activeTab;
      const viewsRef = useRef(views);
      viewsRef.current = views;
      const togglingRef = useRef(toggling);
      togglingRef.current = toggling;
      const seqRef = useRef({ skills: 0, instructions: 0, mcp: 0 });
      const abortRef = useRef({});
      const bootSeqRef = useRef(0);
      const detailSeqRef = useRef(0);
      const detailAbortRef = useRef(null);
      const editorSeqRef = useRef(0);
      const editorAbortRef = useRef(null);
      const toastSeqRef = useRef(0);
      const toastTimersRef = useRef(new Map());
      const workspaceLoadedRef = useRef('');

      // ----- toasts ------------------------------------------------------------------

      const pushToast = useCallback((toast) => {
        const id = (toastSeqRef.current += 1);
        setToasts((prev) =>
          [...prev, { id, kind: toast.kind || 'success', message: toast.message || '', detail: toast.detail || null }].slice(-3),
        );
        const timer = setTimeout(() => {
          toastTimersRef.current.delete(id);
          setToasts((prev) => prev.filter((item) => item.id !== id));
        }, TOAST_MS);
        toastTimersRef.current.set(id, timer);
      }, []);

      // ----- loading -----------------------------------------------------------------

      const loadTab = useCallback(async (tab, wsPath) => {
        if (!TAB_PAYLOAD_PATH[tab]) return;
        seqRef.current[tab] = (seqRef.current[tab] || 0) + 1;
        const seq = seqRef.current[tab];
        try {
          abortRef.current[tab]?.abort();
        } catch {
          // ignore
        }
        const controller = new AbortController();
        abortRef.current[tab] = controller;
        setViews((prev) => ({ ...prev, [tab]: { status: 'loading', error: null, at: prev[tab]?.at || 0 } }));
        try {
          const payload = await requestJson(TAB_PAYLOAD_PATH[tab], {
            params: { workspace: wsPath },
            signal: controller.signal,
          });
          if (!mountedRef.current || seqRef.current[tab] !== seq) return;
          setData((prev) => ({ ...prev, [tab]: payload }));
          setViews((prev) => ({ ...prev, [tab]: { status: 'ready', error: null, at: Date.now() } }));
        } catch (error) {
          if (!mountedRef.current || seqRef.current[tab] !== seq || (error && error.name === 'AbortError')) return;
          setViews((prev) => ({ ...prev, [tab]: { status: 'error', error: errorInfo(error), at: prev[tab]?.at || 0 } }));
        }
      }, []);

      const loadBootstrap = useCallback(async () => {
        const seq = (bootSeqRef.current += 1);
        setBootState('loading');
        setBootError(null);
        try {
          const payload = await requestJson('/bootstrap');
          if (!mountedRef.current || bootSeqRef.current !== seq) return;
          setBootstrap(payload);
          setBootState('ready');
        } catch (error) {
          if (!mountedRef.current || bootSeqRef.current !== seq) return;
          setBootError(errorInfo(error));
          setBootState('error');
        }
      }, []);

      useEffect(() => {
        mountedRef.current = true;
        loadBootstrap();
        return () => {
          mountedRef.current = false;
          for (const controller of Object.values(abortRef.current)) {
            try {
              controller.abort();
            } catch {
              // ignore
            }
          }
          try {
            detailAbortRef.current?.abort();
          } catch {
            // ignore
          }
          try {
            editorAbortRef.current?.abort();
          } catch {
            // ignore
          }
          for (const timer of toastTimersRef.current.values()) clearTimeout(timer);
          toastTimersRef.current.clear();
        };
      }, [loadBootstrap]);

      useEffect(() => {
        if (!bootstrap || !wsPath) return;
        if (workspaceLoadedRef.current === wsPath) return;
        workspaceLoadedRef.current = wsPath;
        setData({ skills: null, instructions: null, mcp: null });
        setViews({});
        setSelectedKey('');
        const tab = TAB_ORDER.includes(activeTabRef.current) ? activeTabRef.current : 'skills';
        if (tabSupported(tab, bootstrap)) loadTab(tab, wsPath);
      }, [bootstrap, wsPath, loadTab]);

      useEffect(() => {
        if (contentRef.current) contentRef.current.scrollTop = 0;
      }, [activeTab]);

      // ----- mutations ---------------------------------------------------------------

      const submitSkill = useCallback(
        async (payload) => {
          try {
            const response = await requestJson('/skill', {
              method: 'POST',
              body: withWorkspace(payload, workspaceRef.current),
            });
            const name = response?.skill?.name || payload.name;
            setDialog(null);
            pushToast({
              kind: 'success',
              message: t(payload.op === 'create' ? 'toast.skill.created' : 'toast.skill.updated', { name }),
            });
            loadTab('skills', workspaceRef.current);
          } catch (error) {
            pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
            throw error;
          }
        },
        [loadTab, pushToast, t],
      );

      const submitInstruction = useCallback(
        async (payload) => {
          try {
            await requestJson('/instruction', {
              method: 'POST',
              body: withWorkspace(payload, workspaceRef.current),
            });
            setDialog(null);
            pushToast({
              kind: 'success',
              message: t('toast.instruction.saved', { name: baseName(payload.path) || payload.path || '' }),
            });
            loadTab('instructions', workspaceRef.current);
          } catch (error) {
            pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
            throw error;
          }
        },
        [loadTab, pushToast, t],
      );

      const submitMcp = useCallback(
        async (payload) => {
          try {
            await requestJson('/mcp', {
              method: 'POST',
              body: withWorkspace(payload, workspaceRef.current),
            });
            setDialog(null);
            pushToast({
              kind: 'success',
              message: t(payload.op === 'create' ? 'toast.mcp.created' : 'toast.mcp.updated', {
                name: payload.server?.serverName || '',
              }),
            });
            loadTab('mcp', workspaceRef.current);
          } catch (error) {
            pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
            throw error;
          }
        },
        [loadTab, pushToast, t],
      );

      const toggleMcp = useCallback(
        async (server, explicitKey) => {
          const key = explicitKey || `${server.scope}:${server.serverName}`;
          if (togglingRef.current[key]) return;
          setToggling((prev) => ({ ...prev, [key]: true }));
          const enabled = !(server.enabled !== false);
          try {
            await requestJson('/mcp', {
              method: 'POST',
              body: withWorkspace(
                {
                  op: 'toggle',
                  scope: server.scope,
                  server: {
                    serverName: server.serverName,
                    scope: server.scope,
                    transport: server.transport,
                  },
                  enabled,
                },
                workspaceRef.current,
              ),
            });
            pushToast({
              kind: 'success',
              message: t(enabled ? 'toast.mcp.enabled' : 'toast.mcp.disabled', { name: server.serverName }),
            });
            loadTab('mcp', workspaceRef.current);
          } catch (error) {
            pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
          } finally {
            setToggling((prev) => {
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
        },
        [loadTab, pushToast, t],
      );

      const trustMcp = useCallback(
        async (server) => {
          try {
            await requestJson('/mcp', {
              method: 'POST',
              body: withWorkspace(
                {
                  op: 'trust',
                  scope: server.scope,
                  server: { serverName: server.serverName },
                  fingerprint: server.fingerprint,
                },
                workspaceRef.current,
              ),
            });
            pushToast({ kind: 'success', message: t('toast.mcp.trusted', { name: server.serverName }) });
            setDialog(null);
            loadTab('mcp', workspaceRef.current);
          } catch (error) {
            pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
          }
        },
        [loadTab, pushToast, t],
      );

      const handleConfirmDelete = useCallback(async () => {
        const pending = confirm;
        if (!pending) return;
        const { tab, target } = pending;
        try {
          if (tab === 'skills') {
            await requestJson('/skill', {
              method: 'POST',
              body: withWorkspace({ op: 'delete', scope: target.scope, name: target.name }, workspaceRef.current),
            });
          } else if (tab === 'instructions') {
            await requestJson('/instruction', {
              method: 'POST',
              body: withWorkspace({ op: 'delete', scope: target.scope, path: target.path }, workspaceRef.current),
            });
          } else {
            await requestJson('/mcp', {
              method: 'POST',
              body: withWorkspace(
                {
                  op: 'delete',
                  scope: target.scope,
                  server: { serverName: target.serverName, scope: target.scope, transport: target.transport },
                },
                workspaceRef.current,
              ),
            });
          }
          setConfirm(null);
          setDialog((prev) => (prev && (prev.kind === 'detail' || prev.kind === 'editor') ? null : prev));
          pushToast({
            kind: 'success',
            message: t(
              tab === 'skills'
                ? 'toast.skill.deleted'
                : tab === 'instructions'
                  ? 'toast.instruction.deleted'
                  : 'toast.mcp.deleted',
              { name: displayEntityName(tab, target, t) },
            ),
          });
          loadTab(tab, workspaceRef.current);
        } catch (error) {
          pushToast({ kind: 'error', message: t('toast.failed'), detail: describeApiError(t, errorInfo(error)) });
          throw error;
        }
      }, [confirm, loadTab, pushToast, t]);

      // ----- dialogs -----------------------------------------------------------------

      const openDetail = useCallback(async (tab, target) => {
        const seq = (detailSeqRef.current += 1);
        try {
          detailAbortRef.current?.abort();
        } catch {
          // ignore
        }
        const controller = new AbortController();
        detailAbortRef.current = controller;
        setDialog({ kind: 'detail', tab, target, status: 'loading', error: null, detail: null });
        try {
          const detail = await fetchDetailPayload(tab, target, workspaceRef.current, controller.signal);
          if (!mountedRef.current || detailSeqRef.current !== seq) return;
          setDialog((prev) => (prev && prev.kind === 'detail' ? { ...prev, status: 'ready', detail } : prev));
        } catch (error) {
          if (!mountedRef.current || detailSeqRef.current !== seq || (error && error.name === 'AbortError')) return;
          setDialog((prev) =>
            prev && prev.kind === 'detail' ? { ...prev, status: 'error', error: errorInfo(error) } : prev,
          );
        }
      }, []);

      const openEditor = useCallback(async (tab, mode, target) => {
        const seq = (editorSeqRef.current += 1);
        try {
          editorAbortRef.current?.abort();
        } catch {
          // ignore
        }
        if (mode === 'create') {
          setDialog({ kind: 'editor', tab, mode, target: null, status: 'ready', error: null, initial: null });
          return;
        }
        const controller = new AbortController();
        editorAbortRef.current = controller;
        setDialog({ kind: 'editor', tab, mode, target, status: 'loading', error: null, initial: null });
        try {
          const detail = await fetchDetailPayload(tab, target, workspaceRef.current, controller.signal);
          if (!mountedRef.current || editorSeqRef.current !== seq) return;
          setDialog((prev) => (prev && prev.kind === 'editor' ? { ...prev, status: 'ready', initial: detail } : prev));
        } catch (error) {
          if (!mountedRef.current || editorSeqRef.current !== seq || (error && error.name === 'AbortError')) return;
          setDialog((prev) =>
            prev && prev.kind === 'editor' ? { ...prev, status: 'error', error: errorInfo(error) } : prev,
          );
        }
      }, []);

      const closeDialog = useCallback(() => {
        try {
          detailAbortRef.current?.abort();
        } catch {
          // ignore
        }
        try {
          editorAbortRef.current?.abort();
        } catch {
          // ignore
        }
        setDialog(null);
      }, []);

      const handleEditFromDialog = useCallback(() => {
        if (!dialog || dialog.kind !== 'detail') return;
        if (dialog.status === 'ready' && dialog.detail) {
          setDialog({
            kind: 'editor',
            tab: dialog.tab,
            mode: 'edit',
            target: dialog.target,
            status: 'ready',
            error: null,
            initial: dialog.detail,
          });
        } else {
          openEditor(dialog.tab, 'edit', dialog.target);
        }
      }, [dialog, openEditor]);

      // ----- interactions ------------------------------------------------------------

      const handleTabChange = useCallback(
        (tab) => {
          if (!TAB_ORDER.includes(tab)) return;
          setActiveTab(tab);
          setSelectedKey('');
          if (tab !== 'skills') setScopeFilter((prev) => (prev === 'bundled' ? 'all' : prev));
          const current = viewsRef.current[tab];
          const stale =
            !current || current.status === 'error' || !current.at || Date.now() - current.at > STALE_MS;
          if (stale && tabSupported(tab, bootstrapRef.current)) loadTab(tab, workspaceRef.current);
        },
        [loadTab],
      );

      const handleRefresh = useCallback(() => {
        if (!bootstrapRef.current) {
          loadBootstrap();
          return;
        }
        if (workspaceRef.current) loadTab(activeTabRef.current, workspaceRef.current);
      }, [loadBootstrap, loadTab]);

      // A manual pick becomes a non-empty override and stays sticky for the page lifetime.
      const handleWorkspaceChange = useCallback((next) => {
        setWorkspaceChoice(String(next || ''));
      }, []);

      const handleCreate = useCallback(() => {
        openEditor(activeTabRef.current, 'create', null);
      }, [openEditor]);

      const handleClearFilters = useCallback(() => {
        setQuery('');
        setScopeFilter('all');
      }, []);

      const handleOpenItem = useCallback(
        (item) => {
          openDetail(activeTabRef.current, item);
        },
        [openDetail],
      );
      const handleEditItem = useCallback(
        (item) => {
          openEditor(activeTabRef.current, 'edit', item);
        },
        [openEditor],
      );
      const handleDeleteItem = useCallback((item) => {
        setConfirm({ tab: item.kind, target: item });
      }, []);
      const handleSelectItem = useCallback((item) => {
        const key = rowKey(activeTabRef.current, item);
        setSelectedKey((prev) => (prev === key ? '' : key));
      }, []);
      const handleToggleItem = useCallback(
        (item) => {
          toggleMcp(item);
        },
        [toggleMcp],
      );

      // ----- derived data ------------------------------------------------------------

      const locale = typeof t.currentLocale === 'function' ? t.currentLocale() : 'zh';
      const bootstrapSafe = bootstrap || {};
      const homes = bootstrapSafe.homes || {};
      const workspaces = Array.isArray(bootstrapSafe.workspaces) ? bootstrapSafe.workspaces : [];
      const isBootReady = bootState === 'ready';
      const isNarrow = rootSize.width > 0 && rootSize.width < 720;
      const isShort = rootSize.height > 0 && rootSize.height < 520;

      const groups = useMemo(() => {
        const needle = query.trim().toLowerCase();
        let items = [];
        if (activeTab === 'skills') items = (data.skills?.skills || []).map(normalizeSkill);
        else if (activeTab === 'instructions') {
          // Only files that exist are rows; missing fixed candidates live behind the create dialog.
          items = (data.instructions?.files || []).map(normalizeInstruction).filter((item) => item.exists);
        }
        else items = (data.mcp?.servers || []).map(normalizeMcp);
        const scoped = items.filter((item) => scopeFilter === 'all' || item.scope === scopeFilter);
        const searched = needle ? scoped.filter((item) => matchesQuery(activeTab, item, needle)) : scoped;
        const bucket = new Map(SCOPE_ORDER.map((scope) => [scope, []]));
        for (const item of searched) {
          const scope = item.scope || 'bundled';
          if (!bucket.has(scope)) bucket.set(scope, []);
          bucket.get(scope).push(item);
        }
        const sorter =
          activeTab === 'skills'
            ? (left, right) => left.name.localeCompare(right.name)
            : activeTab === 'instructions'
              ? (left, right) => left.label.localeCompare(right.label)
              : (left, right) => left.serverName.localeCompare(right.serverName);
        return [...bucket.entries()]
          .filter(([, list]) => list.length > 0)
          .map(([scope, list]) => ({ scope, items: list.sort(sorter) }));
      }, [activeTab, data.skills, data.instructions, data.mcp, query, scopeFilter]);

      const skillsList = Array.isArray(data.skills?.skills) ? data.skills.skills : null;
      const skillCounts = data.skills?.counts && typeof data.skills.counts === 'object' ? data.skills.counts : null;
      const mcpServers = Array.isArray(data.mcp?.servers) ? data.mcp.servers : null;
      const mcpExternal = Array.isArray(data.mcp?.external) ? data.mcp.external : [];
      const instructionFiles = Array.isArray(data.instructions?.files) ? data.instructions.files : null;
      const instructionCandidates = useMemo(
        () => (instructionFiles || []).map(normalizeInstruction),
        [instructionFiles],
      );
      const existingInstructions = useMemo(
        () => instructionCandidates.filter((candidate) => candidate.exists).length,
        [instructionCandidates],
      );
      // Create dialog targets every missing fixed candidate from both scopes, ordered so the first
      // missing workspace file is the default; the request scope always comes from the candidate.
      const instructionCreateCandidates = useMemo(() => {
        const scopeRank = (candidate) => (candidate.scope === 'workspace' ? 0 : 1);
        return instructionCandidates
          .filter((candidate) => !candidate.exists)
          .sort(
            (left, right) =>
              scopeRank(left) - scopeRank(right) || String(left.label).localeCompare(String(right.label)),
          );
      }, [instructionCandidates]);

      const totalForTab =
        activeTab === 'skills'
          ? skillsList?.length || 0
          : activeTab === 'mcp'
            ? mcpServers?.length || 0
            : existingInstructions;
      const builtinCount = skillCounts
        ? formatNumber(Number(skillCounts.bundled) || 0, locale)
        : skillsList
          ? formatNumber(skillsList.filter((skill) => skill?.scope === 'bundled').length, locale)
          : t('detail.none');
      const activeView = views[activeTab] || null;
      const activeStatus = activeView?.status || 'idle';
      const activePayload = data[activeTab] || null;
      const refreshing = activeStatus === 'loading' && Boolean(activePayload);
      const mcpExternalCount = mcpExternal.length;
      const workspaceEntry = workspaces.find((entry) => String(entry?.path || '') === wsPath) || null;
      const workspaceLabel = String(workspaceEntry?.title || '') || baseName(wsPath) || wsPath;

      // ----- render helpers ----------------------------------------------------------

      const renderBootstrapControls = () => {
        const optionList = workspaces
          .map((entry) => ({ value: String(entry?.path || ''), label: String(entry?.title || baseName(entry?.path) || entry?.id || '') }))
          .filter((entry) => entry.value);
        const current = wsPath;
        if (current && !optionList.some((entry) => entry.value === current)) {
          optionList.unshift({ value: current, label: baseName(current) || current });
        }
        if (optionList.length === 0) {
          return h(
            'span',
            { className: 'aa-workspace-plain', title: current || undefined },
            current || t('workspace.none'),
          );
        }
        return h(
          'label',
          { className: 'aa-workspace' },
          h('span', { className: 'aa-workspace-label' }, t('workspace.label')),
          h(
            'select',
            {
              className: 'aa-select',
              value: current,
              disabled: !isBootReady,
              'aria-label': t('workspace.aria'),
              onChange: (event) => handleWorkspaceChange(event.target.value),
            },
            optionList.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        );
      };

      const renderStats = () => {
        const counts = skillCounts
          ? {
              user: Number(skillCounts.user) || 0,
              workspace: Number(skillCounts.workspace) || 0,
              bundled: Number(skillCounts.bundled) || 0,
            }
          : skillsList
            ? {
                user: skillsList.filter((skill) => skill && skill.scope === 'user').length,
                workspace: skillsList.filter((skill) => skill && skill.scope === 'workspace').length,
                bundled: skillsList.filter((skill) => skill && skill.scope === 'bundled').length,
              }
            : null;
        const skillHint = counts
          ? t('stat.skillsHint', {
              user: formatNumber(counts.user, locale),
              workspace: formatNumber(counts.workspace, locale),
              bundled: formatNumber(counts.bundled, locale),
            })
          : t('stat.unknown');
        return h(
          'div',
          { className: 'aa-stats' },
          h(StatTile, {
            label: t('stat.skills'),
            value: skillsList ? formatNumber(skillsList.length, locale) : t('detail.none'),
            hint: skillsList ? skillHint : undefined,
          }),
          h(StatTile, {
            label: t('stat.mcp'),
            value: mcpServers ? formatNumber(mcpServers.length, locale) : t('detail.none'),
            hint: mcpServers ? t('stat.mcpHint', { external: formatNumber(mcpExternalCount, locale) }) : undefined,
          }),
          h(StatTile, {
            label: t('stat.instructions'),
            value: instructionFiles ? formatNumber(existingInstructions, locale) : t('detail.none'),
            hint: instructionFiles
              ? t('stat.instructionsHint', {
                  exists: formatNumber(existingInstructions, locale),
                  total: formatNumber(instructionFiles.length, locale),
                })
              : undefined,
          }),
          h(StatTile, {
            label: t('stat.builtin'),
            value: builtinCount,
            hint: t('stat.builtinHint'),
          }),
        );
      };

      const renderToolbar = () => {
        const scopeValues = activeTab === 'skills' ? ['all', 'user', 'workspace', 'bundled'] : ['all', 'user', 'workspace'];
        return h(
          'div',
          { className: 'aa-toolbar' },
          h(
            'div',
            { className: 'aa-toolbar-left' },
            h(Segmented, {
              value: scopeFilter,
              ariaLabel: t('filter.scopeAria'),
              onChange: setScopeFilter,
              options: scopeValues.map((value) => ({ value, label: t(value === 'all' ? 'scope.all' : scopeKey(value)) })),
            }),
          ),
          h(
            'div',
            { className: 'aa-toolbar-right' },
            h(SearchBox, { t, value: query, onChange: setQuery }),
            activeTab === 'skills'
              ? h(
                  'button',
                  { type: 'button', className: 'aa-btn', onClick: () => setImportOpen(true), disabled: !isBootReady },
                  t('action.importSkill'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'aa-btn aa-btn-primary',
                onClick: handleCreate,
                disabled: !isBootReady || (activeTab === 'instructions' && (!wsPath || instructionFiles === null)),
              },
              h(IconPlus),
              t(TAB_CREATE_KEY[activeTab]),
            ),
          ),
        );
      };

      const renderContent = () => {
        const panelId = `aa-panel-${activeTab}`;
        const wrap = (children) =>
          h(
            'div',
            {
              className: 'aa-content',
              id: panelId,
              role: 'tabpanel',
              'aria-labelledby': `aa-tab-${activeTab}`,
              ref: contentRef,
            },
            children,
          );

        if (bootState === 'error') {
          return wrap(
            h(EmptyState, {
              t,
              icon: 'error',
              title: t('state.error.title'),
              body: describeApiError(t, bootError),
              action: h(
                'button',
                { type: 'button', className: 'aa-btn aa-btn-primary', onClick: loadBootstrap },
                t('action.retry'),
              ),
            }),
          );
        }
        if (!isBootReady) return wrap(h(SkeletonRows, { rows: 4, t }));
        if (!wsPath) {
          return wrap(
            h(EmptyState, {
              t,
              icon: 'lock',
              title: t('state.noWorkspace.title'),
              body: t('state.noWorkspace.body'),
              action: h(
                'button',
                { type: 'button', className: 'aa-btn', onClick: loadBootstrap },
                t('action.retry'),
              ),
            }),
          );
        }
        if (!tabSupported(activeTab, bootstrap)) {
          return wrap(
            h(EmptyState, {
              t,
              icon: 'lock',
              title: t('state.unsupported.title'),
              body: t('state.unsupported.body', { feature: t(TAB_LABEL_KEY[activeTab]) }),
            }),
          );
        }
        if (!activePayload) {
          if (activeStatus === 'error') {
            return wrap(
              h(EmptyState, {
                t,
                icon: 'error',
                title: t('state.error.title'),
                body: describeApiError(t, activeView.error),
                action: h(
                  'button',
                  {
                    type: 'button',
                    className: 'aa-btn aa-btn-primary',
                    onClick: () => loadTab(activeTab, wsPath),
                  },
                  t('action.retry'),
                ),
              }),
            );
          }
          return wrap(h(SkeletonRows, { rows: 4, t }));
        }

        const children = [];
        if (activeStatus === 'error') {
          children.push(
            h(InlineError, {
              key: 'inline-error',
              t,
              info: activeView.error,
              onRetry: () => loadTab(activeTab, wsPath),
            }),
          );
        }
        const warnings = Array.isArray(activePayload.warnings) ? activePayload.warnings : [];
        if (warnings.length > 0) children.push(h(WarningNote, { key: 'warnings', t, warnings }));
        if (activeStatus === 'loading') {
          children.push(h('div', { key: 'progress', className: 'aa-progress' }, h('div', { className: 'aa-progress-bar' })));
        }
        if (groups.length === 0) {
          if (totalForTab === 0) {
            children.push(
              h(EmptyState, {
                key: 'empty',
                t,
                tab: activeTab,
                title: t(`state.empty.${activeTab}.title`),
                body: t(`state.empty.${activeTab}.body`),
                action: h(
                  'button',
                  { type: 'button', className: 'aa-btn aa-btn-primary', onClick: handleCreate },
                  t(TAB_CREATE_KEY[activeTab]),
                ),
              }),
            );
          } else {
            children.push(
              h(EmptyState, {
                key: 'empty-filter',
                t,
                title: t('state.emptyFilter.title'),
                body: t('state.emptyFilter.body'),
                action: h(
                  'button',
                  { type: 'button', className: 'aa-btn', onClick: handleClearFilters },
                  t('action.clearFilters'),
                ),
              }),
            );
          }
        } else {
          for (const group of groups) {
            children.push(
              h(Section, {
                key: `group:${group.scope}`,
                t,
                locale,
                tab: activeTab,
                scope: group.scope,
                items: group.items,
                workspace: wsPath,
                workspaceLabel,
                homes,
                selectedKey,
                onOpen: handleOpenItem,
                onEdit: handleEditItem,
                onDelete: handleDeleteItem,
                onToggle: handleToggleItem,
                onSelectToggle: handleSelectItem,
                isTogglePending: (item) => Boolean(toggling[`${item.scope}:${item.serverName}`]),
              }),
            );
          }
        }
        if (activeTab === 'mcp') {
          children.push(h(ExternalNote, { key: 'external', t, locale, external: mcpExternal }));
        }
        return wrap(children);
      };

      const renderDialogs = () => {
        const nodes = [];
        if (dialog && dialog.kind === 'detail') {
          const toggleServer = dialog.detail || dialog.target || {};
          nodes.push(
            h(DetailDialog, {
              key: 'detail',
              t,
              locale,
              dialog,
              onClose: closeDialog,
              onRetry: () => openDetail(dialog.tab, dialog.target),
              onEdit: handleEditFromDialog,
              onDelete: (target) => setConfirm({ tab: dialog.tab, target }),
              onToggle: toggleMcp,
              isToggling: Boolean(toggling[`${toggleServer.scope}:${toggleServer.serverName}`]),
              onTrust: trustMcp,
            }),
          );
        }
        if (dialog && dialog.kind === 'editor') {
          const editorCommon = {
            key: 'editor',
            t,
            locale,
            dialog,
            workspace: wsPath,
            homes,
            onCancel: closeDialog,
            onRetry: () => openEditor(dialog.tab, dialog.mode, dialog.target),
          };
          if (dialog.tab === 'skills') {
            nodes.push(h(SkillEditor, { ...editorCommon, onSubmit: submitSkill }));
          } else if (dialog.tab === 'instructions') {
            nodes.push(
              h(InstructionEditor, {
                ...editorCommon,
                candidates: instructionCreateCandidates,
                onSubmit: submitInstruction,
                onDelete: (target) => setConfirm({ tab: 'instructions', target }),
              }),
            );
          } else {
            nodes.push(h(McpEditor, { ...editorCommon, onSubmit: submitMcp }));
          }
        }
        if (importOpen) {
          nodes.push(
            h(ImportSkillDialog, {
              key: 'import',
              t,
              workspace: wsPath,
              pickDirectory,
              pushToast,
              onCancel: () => setImportOpen(false),
              onImported: (count) => {
                setImportOpen(false);
                if (count > 0) loadTab('skills', workspaceRef.current);
              },
            }),
          );
        }
        if (confirm) {
          nodes.push(
            h(ConfirmDialog, {
              key: 'confirm',
              t,
              spec: buildConfirmSpec(t, confirm.tab, confirm.target),
              onCancel: () => setConfirm(null),
              onConfirm: handleConfirmDelete,
            }),
          );
        }
        return nodes;
      };

      return h(
        'div',
        {
          className: `aa-root${isNarrow ? ' is-narrow' : ''}${isShort ? ' is-short' : ''}`,
          ref: rootRef,
          'aria-label': t('page.aria'),
        },
        h('style', null, CSS),
        h(
          'div',
          { className: 'aa-panel' },
          h(
            'div',
            { className: 'aa-header', 'data-window-drag': true },
            h(
              'div',
              { className: 'aa-brand' },
              h('span', { className: 'aa-brand-icon' }, h(IconAgentAssets, { size: 17 })),
              h(
                'div',
                { className: 'aa-brand-text' },
                h('div', { className: 'aa-title' }, t('page.title')),
                h('div', { className: 'aa-subtitle' }, t('page.subtitle')),
              ),
            ),
            h(
              'div',
              { className: 'aa-header-right' },
              renderBootstrapControls(),
              h(
                'button',
                {
                  type: 'button',
                  className: 'aa-icon-btn',
                  onClick: handleRefresh,
                  disabled: bootState === 'loading' || refreshing,
                  title: refreshing ? t('action.refreshing') : t('action.refresh'),
                  'aria-label': refreshing ? t('action.refreshing') : t('action.refresh'),
                  'aria-busy': refreshing || undefined,
                },
                h('span', { className: `aa-refresh-icon${refreshing || bootState === 'loading' ? ' is-spinning' : ''}` }, h(IconRefresh)),
              ),
            ),
          ),
          renderStats(),
          h(
            'div',
            { className: 'aa-tabrow' },
            h(Tabs, {
              t,
              locale,
              active: activeTab,
              onChange: handleTabChange,
              tabs: [
                { key: 'skills', labelKey: 'tab.skills', count: data.skills ? skillsList?.length || 0 : null },
                { key: 'mcp', labelKey: 'tab.mcp', count: data.mcp ? mcpServers?.length || 0 : null },
                {
                  key: 'instructions',
                  labelKey: 'tab.instructions',
                  count: data.instructions ? existingInstructions : null,
                },
              ],
            }),
          ),
          renderToolbar(),
          renderContent(),
        ),
        renderDialogs(),
        h(ToastLayer, { t, toasts }),
      );
    }

    // -------------------------------------------------------------------------------------
    // Styles — theme tokens only (--dsw-alias-* / --dsw-font-*), readable in light + dark.
    // -------------------------------------------------------------------------------------

    const CSS = `
.aa-root { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.aa-root *, .aa-root *::before, .aa-root *::after { box-sizing: border-box; }
.aa-root :focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.aa-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.aa-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.aa-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 14px 18px 12px; }

/* header */
.aa-header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; }
html[data-platform=darwin] .aa-panel { padding-top: 6px; }
html[data-platform=darwin] .aa-header { min-height: max(40px, calc(var(--dsh-frame-top-clearance, 0px) - 6px));
  padding-left: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 10px)); }
.aa-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.aa-brand-icon { width: 30px; height: 30px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 9px;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
.aa-brand-text { min-width: 0; }
.aa-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.aa-subtitle { margin-top: 1px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48vw; }
.aa-header-right { display: flex; align-items: center; gap: 8px; flex: none; }
.aa-workspace { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.aa-workspace-label { font-size: 11px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.aa-workspace-plain { font-size: 11.5px; color: var(--dsw-alias-label-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-select { appearance: none; height: 28px; max-width: 190px; padding: 0 24px 0 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2);
  background-color: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 11.5px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%), linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%);
  background-position: calc(100% - 12px) 50%, calc(100% - 8px) 50%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.aa-select:disabled { opacity: .6; cursor: default; }
.aa-select:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.aa-select-block { width: 100%; max-width: none; height: 30px; }
.aa-icon-btn { width: 29px; height: 29px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.aa-icon-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.aa-icon-btn:disabled { opacity: .5; cursor: default; }
.aa-refresh-icon { display: inline-flex; }
.aa-refresh-icon.is-spinning { animation: aa-spin .9s linear infinite; }

/* scope summary */
.aa-stats { flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.aa-stat { min-width: 0; padding: 8px 12px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.aa-stat-label { font-size: 10.5px; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aa-stat-value { margin-top: 1px; font-size: 19px; font-weight: 650; line-height: 1.2; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.aa-stat-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* tabs */
.aa-tabrow { flex: none; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aa-tabs { display: flex; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.aa-tabs::-webkit-scrollbar { display: none; }
.aa-tab { display: inline-flex; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
  background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 12.5px; padding: 6px 11px 8px;
  cursor: pointer; white-space: nowrap; transition: color .12s ease, background .12s ease; }
.aa-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.aa-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-weight: 600; }
.aa-tab-count { min-width: 17px; padding: 0 5px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }

/* toolbar */
.aa-import-row { display: flex; gap: 8px; align-items: center; }
.aa-import-row .aa-input { flex: 1 1 auto; min-width: 0; }
.aa-import-result { display: flex; flex-direction: column; gap: 8px; }
.aa-import-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.aa-import-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; padding-right: 2px; }
.aa-import-item { display: flex; align-items: flex-start; gap: 10px; padding: 9px 11px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.aa-import-item:hover { border-color: var(--dsw-alias-border-l2); }
.aa-import-item.is-blocked { cursor: default; opacity: .72; }
.aa-import-item input { margin-top: 3px; }
.aa-import-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.aa-import-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.aa-import-name { font-size: 13px; font-weight: 600; }
.aa-import-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.aa-import-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aa-check { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; cursor: pointer; }
.aa-import-overwrite { flex-wrap: wrap; }
.aa-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-toolbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.aa-toolbar-left, .aa-toolbar-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
.aa-toolbar-right { flex: 1 1 auto; justify-content: flex-end; }
.aa-seg { display: inline-flex; padding: 2px; gap: 1px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.aa-seg-item { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11.5px; padding: 3px 9px;
  border-radius: 5px; cursor: pointer; white-space: nowrap; }
.aa-seg-item:hover { color: var(--dsw-alias-label-primary); }
.aa-seg-item.is-active { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.aa-seg-item:disabled { opacity: .45; cursor: default; }
.aa-search { position: relative; display: flex; align-items: center; flex: 0 1 240px; min-width: 120px; }
.aa-search-icon { position: absolute; left: 9px; display: inline-flex; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
.aa-search-input { width: 100%; height: 29px; padding: 0 28px 0 28px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; }
.aa-search-input::placeholder { color: var(--dsw-alias-label-tertiary); }
.aa-search-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.aa-search-clear { position: absolute; right: 5px; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center;
  padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.aa-search-clear:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }

/* buttons */
.aa-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 5px 11px; font-size: 12px; font-weight: 500; font-family: inherit;
  cursor: pointer; white-space: nowrap; transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.aa-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.aa-btn:disabled { opacity: .55; cursor: default; }
.aa-btn-sm { padding: 3px 9px; font-size: 11px; border-radius: 6px; }
.aa-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground); }
.aa-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.aa-btn-danger { background: var(--dsw-alias-state-error-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.aa-btn-danger:hover:not(:disabled) { filter: brightness(1.06); background: var(--dsw-alias-state-error-primary); }
.aa-btn-ghost-danger { border-color: transparent; color: var(--dsw-alias-state-error-primary); }
.aa-btn-ghost-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.aa-link-btn { padding: 0; border: 0; background: transparent; color: var(--dsw-alias-link, var(--dsw-alias-state-business-primary));
  font-family: inherit; font-size: 11px; cursor: pointer; }
.aa-link-btn:hover { opacity: .8; }
.aa-spinner { display: inline-block; border: 1.6px solid currentColor; border-right-color: transparent; border-radius: 50%;
  animation: aa-spin .8s linear infinite; flex: none; }

/* scrollable content */
.aa-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 12px;
  padding: 2px 2px 8px; scrollbar-gutter: stable; }
.aa-content::-webkit-scrollbar { width: 8px; }
.aa-content::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px; }
.aa-content::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
.aa-content::-webkit-scrollbar-track { background: transparent; }

/* groups + rows */
.aa-group { display: flex; flex-direction: column; gap: 5px; }
.aa-group-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 2px; }
.aa-group-title { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aa-group-count { flex: none; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/* Wide screens show two (or more) columns of rows so more assets fit on one screen. */
.aa-rows { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 440px), 1fr)); gap: 6px; align-items: stretch; }
.aa-row { position: relative; display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; min-width: 0;
  transition: background .12s ease, border-color .12s ease; }
.aa-row:hover, .aa-row:focus-visible { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.aa-row.is-selected { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.aa-row-icon { flex: none; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; margin-top: 1px; }
.aa-row-icon-skills { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
.aa-row-icon-mcp { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.aa-row-icon-instructions { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.aa-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.aa-row-titleline { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: nowrap; }
.aa-row-name { font-size: 13px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-row-desc { font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); min-width: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
.aa-row-desc-mono { font-size: 11px; color: var(--dsw-alias-label-secondary); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-row-meta { display: flex; align-items: center; gap: 8px; min-width: 0; margin-top: 2px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.aa-row-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-row-meta-facts { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.aa-row-right { flex: none; display: flex; align-items: center; gap: 6px; align-self: center; }
.aa-row-actions { display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity .12s ease; }
.aa-row:hover .aa-row-actions, .aa-row:focus-within .aa-row-actions, .aa-root.is-narrow .aa-row-actions { opacity: 1; }
.aa-row-action { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px;
  padding: 3px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.aa-row-action:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.aa-row-action.is-danger:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }

/* badges */
.aa-badge { flex: none; display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 0 7px;
  font-size: 9.5px; line-height: 1.7; font-weight: 500; }
.aa-badge-brand { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent); }
.aa-badge-ok { color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.aa-badge-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
.aa-badge-error { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }

/* switch */
.aa-switch { position: relative; flex: none; width: 32px; height: 18px; padding: 0; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background .12s ease, border-color .12s ease; }
.aa-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base)); transition: left .12s ease; }
.aa-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); border-color: transparent; }
.aa-switch[aria-checked="true"]::after { left: 16px; }
.aa-switch:disabled { opacity: .5; cursor: default; }
.aa-switch-pending { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 18px; color: var(--dsw-alias-label-tertiary); }

/* states */
.aa-state { flex: 1 1 auto; min-height: 160px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 20px; text-align: center; }
.aa-state-icon { width: 38px; height: 38px; display: inline-flex; align-items: center; justify-content: center; border-radius: 11px;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 10%, transparent); }
.aa-state-icon.is-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.aa-state-icon.is-lock { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-interactive-bg-hover); }
.aa-state-title { font-size: 14px; font-weight: 600; }
.aa-state-body { font-size: 11.5px; color: var(--dsw-alias-label-secondary); max-width: 520px; line-height: 1.55; }
.aa-state .aa-btn { margin-top: 2px; }
.aa-skeletons { display: flex; flex-direction: column; gap: 6px; }
.aa-skeleton-row { height: 58px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1);
  background: linear-gradient(90deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1));
  background-size: 200% 100%; animation: aa-shimmer 1.3s ease-in-out infinite; }
.aa-skeleton-line { height: 13px; border-radius: 6px; background: var(--dsw-alias-bg-skeleton);
  animation: aa-shimmer 1.3s ease-in-out infinite; }
.aa-dialog-loading { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; }
.aa-progress { flex: none; height: 2px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-bg-layer-2); position: relative; }
.aa-progress-bar { position: absolute; inset: 0; width: 34%; border-radius: 2px;
  background: linear-gradient(90deg, transparent, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)), transparent);
  animation: aa-slide 1.1s ease-in-out infinite; }
.aa-note { display: flex; align-items: flex-start; gap: 7px; padding: 8px 11px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1.5; min-width: 0; }
.aa-note-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); }
.aa-note-list { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.aa-inline-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 11px; border-radius: 8px;
  font-size: 11.5px; color: var(--dsw-alias-state-error-primary);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent); }
.aa-inline-error-text { min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.aa-inline-error-title { font-weight: 600; }
.aa-inline-error-detail { color: var(--dsw-alias-label-secondary); word-break: break-word; }

/* dialogs */
.aa-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--dsw-alias-bg-mask-drop); backdrop-filter: blur(2px); animation: aa-fade-in .14s ease-out; }
.aa-overlay.is-raised { z-index: 70; }
.aa-dialog { width: min(660px, 100%); max-height: min(86vh, 100%); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 14px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); animation: aa-dialog-in .14s ease-out; }
.aa-dialog.is-wide { width: min(780px, 100%); }
.aa-dialog.is-narrow { width: min(440px, 100%); }
.aa-dialog-head { flex: none; padding: 14px 18px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.aa-dialog-title { font-size: 14.5px; font-weight: 650; letter-spacing: -0.01em; word-break: break-word; }
.aa-dialog-sub { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-mono, ui-monospace, monospace);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aa-dialog-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 18px 16px; }
.aa-dialog-body::-webkit-scrollbar { width: 8px; }
.aa-dialog-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px; }
.aa-dialog-foot { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 18px 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.aa-foot-spacer { flex: 1 1 auto; }
.aa-confirm { display: flex; flex-direction: column; gap: 10px; }
.aa-confirm-text { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word; }
.aa-confirm-path { padding: 7px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px; word-break: break-all; }

/* forms */
.aa-form { display: flex; flex-direction: column; gap: 12px; }
.aa-form-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.aa-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.aa-label { font-size: 11.5px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.aa-input, .aa-textarea { width: 100%; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12.5px; line-height: 1.5; padding: 7px 10px; }
.aa-input { height: 31px; }
.aa-textarea { min-height: 56px; resize: vertical; }
.aa-textarea-tall { min-height: 190px; }
.aa-input:disabled { opacity: .7; cursor: default; }
.aa-input::placeholder, .aa-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }
.aa-input:focus-visible, .aa-textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.aa-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary); line-height: 1.45; }
.aa-field-error { font-size: 10.5px; color: var(--dsw-alias-state-error-primary); line-height: 1.45; }
.aa-scope-line { min-height: 31px; display: flex; align-items: center; }
.aa-fixed-file { min-height: 31px; display: flex; align-items: center; gap: 8px; min-width: 0; }
.aa-fixed-file > .aa-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.aa-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 0; }

/* detail */
.aa-detail { display: flex; flex-direction: column; gap: 14px; }
.aa-detail-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.aa-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; }
.aa-meta-item { min-width: 0; }
.aa-meta-item.is-wide { grid-column: 1 / -1; }
.aa-meta-label { font-size: 10.5px; letter-spacing: .02em; color: var(--dsw-alias-label-tertiary); }
.aa-meta-value { margin-top: 1px; font-size: 12px; color: var(--dsw-alias-label-primary); word-break: break-word; }
.aa-meta-value.aa-mono { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.aa-block { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.aa-block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.aa-block-label { font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-secondary); }
.aa-block-body { min-width: 0; }
.aa-detail-text { font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-primary); word-break: break-word; }
.aa-pre { margin: 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
.aa-pre.is-tall { max-height: 420px; }
.aa-pre::-webkit-scrollbar { width: 8px; height: 8px; }
.aa-pre::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px; }
.aa-shadow-list { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.aa-config { display: flex; flex-direction: column; gap: 10px; }
.aa-config-row { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.aa-kv-list { display: flex; flex-direction: column; gap: 2px; }
.aa-kv { display: flex; align-items: baseline; gap: 10px; min-width: 0; font-size: 11px; }
.aa-kv-key { flex: none; color: var(--dsw-alias-label-secondary); max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.aa-kv-value { min-width: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }

/* toasts */
.aa-toasts { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 80; display: flex; flex-direction: column;
  align-items: center; gap: 8px; pointer-events: none; max-width: min(560px, calc(100vw - 32px)); }
.aa-toast { pointer-events: auto; display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 8px 14px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent); font-size: 12px;
  animation: aa-toast-in .16s ease-out; }
.aa-toast.is-success { color: var(--dsw-alias-state-success-primary); }
.aa-toast.is-error { color: var(--dsw-alias-state-error-primary); }
.aa-toast-text { color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aa-toast-detail { color: var(--dsw-alias-label-tertiary); font-size: 10.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* error boundary fallback */
.aa-fallback { height: 100%; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px;
  padding: 24px; text-align: center; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.aa-fallback-title { font-size: 14px; font-weight: 600; }
.aa-fallback-body { font-size: 11.5px; color: var(--dsw-alias-label-secondary); max-width: 420px; line-height: 1.55; }
.aa-icon-fallback { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
  border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 4px; color: var(--dsw-alias-state-error-primary);
  font-size: 10px; line-height: 1; }

/* responsive */
.aa-root.is-narrow .aa-panel { padding: 10px 12px 10px; gap: 8px; }
.aa-root.is-narrow .aa-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.aa-root.is-narrow .aa-subtitle { display: none; }
.aa-root.is-narrow .aa-header-right { gap: 6px; }
.aa-root.is-narrow .aa-stat-hint { display: none; }
.aa-root.is-narrow .aa-search { flex-basis: 170px; }
.aa-root.is-narrow .aa-form-row { grid-template-columns: minmax(0, 1fr); }
.aa-root.is-narrow .aa-meta-grid { grid-template-columns: minmax(0, 1fr); }
.aa-root.is-narrow .aa-workspace-label { display: none; }
.aa-root.is-short .aa-subtitle, .aa-root.is-short .aa-stat-hint { display: none; }
.aa-root.is-short .aa-stat { padding: 5px 10px 6px; }
.aa-root.is-short .aa-stat-value { font-size: 16px; }

@keyframes aa-spin { to { transform: rotate(360deg); } }
@keyframes aa-shimmer { 0% { background-position: 150% 0; } 100% { background-position: -50% 0; } }
@keyframes aa-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
@keyframes aa-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes aa-dialog-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@keyframes aa-toast-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) {
  .aa-refresh-icon.is-spinning, .aa-spinner, .aa-skeleton-row, .aa-skeleton-line, .aa-progress-bar,
  .aa-overlay, .aa-dialog, .aa-toast { animation: none; }
}
`;

    // -------------------------------------------------------------------------------------
    // Mount
    // -------------------------------------------------------------------------------------

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ctx.locale.register(NS, { zh, en });
      } catch {
        // Locale service is optional at mount time; our own dictionaries still work.
      }
      const t = makeTranslate(ctx);
      const subscribeLocale = (listener) => {
        try {
          return ctx.locale.subscribe(listener);
        } catch {
          return () => {};
        }
      };

      /** Native folder picker of the Web GUI shell, when the profile provides one. */
      const pickDirectory = (() => {
        let service;
        try {
          service = ctx.get?.('uiWorkspace');
        } catch {
          service = undefined;
        }
        return service && typeof service.pickDirectory === 'function' ? () => service.pickDirectory() : undefined;
      })();
      const GuardedIcon = guard(IconAgentAssets, t, 'icon');
      const GuardedPage = guard(AgentAssetsPage, t, 'page');

      const disposers = [];
      try {
        disposers.push(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => t('entry.label'),
              },
              GuardedIcon,
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ t, subscribeLocale, pickDirectory }),
              },
              GuardedPage,
            ),
          ),
        );
      } catch (error) {
        console.error('[agent-assets] panel registration failed:', error);
      }

      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              // Disposal is best-effort.
            }
          }
        },
        'agent-assets: ui mounts',
      );
    }

    return { inject, apply };
  },
});
