/**
 * 网盘备份维护 — Client half.
 *
 * 在 DSH Web GUI 左侧栏注册入口（id `dsh-maintenance`，order 40，label「网盘备份」），
 * 并在主区渲染维护面板：顶部四张状态卡（连接 / 最近备份 / 云端快照 / 下次自动备份）
 * + 四个标签页（总览 / 备份范围 / 快照与还原 / 设置）。
 *
 * 数据全部来自插件自身的 loopback JSON API `/api/dsh-maintenance/*`（见 docs/CONTRACT.md），
 * 有任务运行时 1.5s 轮询 overview，空闲时 10s。纯 React.createElement，无 JSX，只 require('react')。
 * 样式一律使用 `--dsw-alias-*` 主题 token（图标 artwork 用 currentColor），类名前缀 mb-。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-maintenance-backup',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'dsh-maintenance';
    const PANEL_ID = 'dsh-maintenance';
    const PANEL_ORDER = 40;
    const API_BASE = '/api/dsh-maintenance';
    const POLL_RUNNING_MS = 1500;
    const POLL_IDLE_MS = 10_000;
    const LOG_LINES = 80;
    const SAMPLE_LIMIT = 100;
    const INTERVAL_OPTIONS = [15, 60, 360, 1440];
    const DEBOUNCE_OPTIONS = [30, 60, 120, 300];
    const KEEP_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const RESTORE_SCOPES = ['all', 'config', 'workspace'];
    const TABS = [
      { id: 'overview', key: 'tab.overview' },
      { id: 'scope', key: 'tab.scope' },
      { id: 'snapshots', key: 'tab.snapshots' },
      { id: 'settings', key: 'tab.settings' },
    ];
    const PROTECTED = [
      { path: '.credentials.yaml', key: 'p.credentials' },
      { path: 'sessions/', key: 'p.sessions' },
      { path: 'cache/', key: 'p.cache' },
      { path: 'storages/', key: 'p.storages' },
      { path: 'node_modules/', key: 'p.nodeModules' },
      { path: '.git/', key: 'p.git' },
      { path: 'skills/quarkclouddrive/', key: 'p.quark' },
    ];
    const TIPS = [
      { key: 'ov.tipPath' },
      { key: 'ov.tipPnpm', commandKey: 'ov.tipPnpmCommand' },
      { key: 'ov.tipLaunchd', commandKey: 'ov.tipLaunchdCommand' },
    ];

    // ---------------------------------------------------------------------------------------
    // Copy — 中文为主文案，en 镜像每个 key
    // ---------------------------------------------------------------------------------------

    const zh = {
      'entry.label': '网盘备份',
      'page.title': '网盘备份',
      'page.subtitle': '把 DSH 配置、技能与本地插件工程备份到夸克网盘',
      'page.aria': '网盘备份维护面板',
      'action.backup': '立即备份',
      'action.backupBusy': '{stage} {progress}%',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.saving': '保存中…',
      'action.confirm': '确认',
      'action.dismiss': '忽略',
      'action.select': '选择',

      'tab.overview': '总览',
      'tab.scope': '备份范围',
      'tab.snapshots': '快照与还原',
      'tab.settings': '设置',
      'tabs.aria': '维护面板分类',

      'header.busyBackup': '备份中',
      'header.busyRestore': '还原中',
      'card.connection': '网盘连接',
      'card.lastBackup': '最近备份',
      'card.snapshots': '云端快照',
      'card.nextBackup': '下次自动备份',

      'conn.state.connected': '已连接',
      'conn.state.unauthorized': '未授权',
      'conn.state.error': '网络异常',
      'conn.state.unknown': '检测中',
      'conn.nickname': '账号',
      'conn.nicknameUnknown': '未返回昵称',
      'conn.vip': '会员类型',
      'conn.usage': '已用 {used} / 共 {total}',
      'conn.expires': '到期 {date}',
      'conn.expiresUnknown': '到期时间未知',
      'conn.checked': '检测于 {time}',
      'conn.stale': '缓存数据，点「重新检测」获取最新状态',
      'conn.retry': '重新检测',
      'conn.retrying': '检测中…',
      'conn.reauth.title': '重新授权',
      'conn.reauth.body': '粘贴夸克授权码完成登录，授权码只用于本次授权，不会写入快照。',
      'conn.reauth.placeholder': '授权码',
      'conn.reauth.submit': '授权登录',
      'conn.reauth.submitting': '授权中…',
      'conn.reauth.hint': '终端兜底：在终端运行下面的命令，命令会打开浏览器并阻塞等待授权完成。',
      'conn.reauth.command': 'node ~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs login',
      'conn.reauth.commandNote': '授权完成后回到本页点「重新检测」。',
      'conn.error.retry': '重试连接',

      'last.meta': '{time} · 耗时 {duration}',
      'last.metaSize': '{size} · {files} 个文件',
      'last.metaSizeOnly': '快照 {size}',
      'snap.meta': '保留最近 {n} 份',
      'snap.archived': '另有 {n} 份已归档到 _archive',
      'next.every': '{time} · {interval}',
      'ov.healthy': '一切正常',
      'ov.healthyBody': '没有需要处理的警告，备份按计划进行。',
      'ov.attention': '{n} 项需要注意',
      'ov.policy': '定时策略',
      'last.never': '还没有备份记录',
      'last.neverHint': '点右上角「立即备份」创建第一份云端快照。',
      'last.time': '时间',
      'last.duration': '耗时',
      'last.files': '文件数',
      'last.size': '大小',
      'last.running': '正在{stage}，{progress}%',
      'last.error': '失败原因',
      'last.partial': '快照不完整（有目录不可读）',

      'result.success': '成功',
      'result.skipped': '跳过',
      'result.failed': '失败',
      'result.running': '进行中',
      'result.unknown': '未知',

      'snap.count': '{n} 份',
      'snap.keep': '保留 {n} 份',
      'snap.archive': '_archive 目录不会自动删除，请在夸克 App 手动清空',
      'snap.loading': '统计中…',
      'snap.unknown': '尚未统计',
      'snap.open': '查看快照',

      'next.off': '已关闭',
      'next.waiting': '启用中，等待计算',
      'next.countdown': '{countdown}后',
      'next.at': '{time}',
      'next.watchOn': '监听模式：变更即备份（防抖 {n}s）',
      'next.watchOff': '监听模式：已关闭',
      'next.hint': '定时备份已关闭，可在「设置」中开启',
      'next.open': '打开设置',

      'ov.summary': '摘要',
      'ov.connectionRow': '连接',
      'ov.lastRow': '最近备份',
      'ov.scheduleRow': '定时策略',
      'ov.warnings': '注意事项',
      'ov.warningsEmpty': '当前没有警告。',
      'ov.protected': '不能备份 / 受保护',
      'ov.protectedIntro': '下列路径不会进入快照，还原时也不会被删除或覆盖：',
      'ov.tips': '提示',
      'ov.scheduleOff': '定时备份已关闭（仍可手动备份）',
      'ov.watchOn': '文件监听已开启，变更后 {n}s 触发备份',
      'ov.watchOff': '文件监听已关闭',
      'ov.scopeLine': '{files} 文件 / {bytes}',
      'ov.scopeRow': '备份范围',
      'ov.scopeUnknown': '备份范围尚未扫描，打开「备份范围」页查看',
      'ov.lock': '当前有{kind}任务运行中',
      'p.credentials': '凭据文件只留本机，绝不进快照。',
      'p.sessions': '会话历史体积大且含隐私，不进快照。',
      'p.cache': '缓存与运行时存储，可重建，不进快照。',
      'p.storages': '本地存储与附件，不进快照。',
      'p.nodeModules': '依赖目录，还原后需在工程内重新安装。',
      'p.git': '版本库目录，避免污染仓库。',
      'p.quark': '夸克技能运行时目录（登录态、任务记录、上传队列）。',
      'ov.tipPath': '换机还原后本地绝对路径可能与快照不同；插件会按主机名与路径映射尽量适配，仍对不上时请手动检查。',
      'ov.tipPnpm': '还原后如包含插件工程，请在对应目录执行命令补齐依赖（node_modules 不备份）。',
      'ov.tipLaunchd': '如果本机用过 launchd 定时任务，请先卸载旧 plist，再由本插件接管定时备份。',
      'ov.tipPnpmCommand': 'pnpm install',
      'ov.tipLaunchdCommand': 'launchctl unload ~/Library/LaunchAgents/*.plist',

      'scope.title': '备份范围',
      'scope.subtitle': '每项把本地路径打包成包内目标路径；可单独关闭某一项。',
      'scope.refresh': '刷新范围',
      'scope.loading': '正在扫描备份范围…',
      'scope.error': '读取备份范围失败',
      'scope.col.name': '项目',
      'scope.col.local': '本地路径',
      'scope.col.dest': '包内路径',
      'scope.col.files': '文件数',
      'scope.col.bytes': '大小',
      'scope.col.readable': '可读',
      'scope.col.discovered': '发现',
      'scope.col.enabled': '启用',
      'scope.readable': '可读',
      'scope.unreadable': '不可读',
      'scope.missing': '路径不存在',
      'scope.discovered': '自动发现',
      'scope.empty': '没有可备份的条目',
      'scope.emptyBody': '请检查插件配置里的备份路径是否存在，然后刷新范围。',
      'scope.excluded': '不备份 / 排除（{n}）',
      'scope.notes': '扫描说明',
      'scope.totals': '已启用 {enabled}/{total} 项，共 {files} 文件 / {bytes}',
      'scope.unreadableCount': '{n} 项不可读',
      'scope.toggleFailed': '切换失败，已回滚',
      'scope.busyHint': '任务进行中，暂不能修改备份范围',

      'snapTab.title': '快照与还原',
      'snapTab.subtitle': '先查看清单并生成差异，确认后再执行两阶段还原。',
      'snapTab.refresh': '刷新快照',
      'snapTab.loading': '正在读取云端快照…',
      'snapTab.error': '读取快照失败',
      'snapTab.col.name': '快照',
      'snapTab.col.date': '日期',
      'snapTab.col.size': '大小',
      'snapTab.col.state': '状态',
      'snapTab.col.sidecar': '清单',
      'snapTab.col.actions': '操作',
      'snapTab.complete': '完整',
      'snapTab.incomplete': '不完整',
      'snapTab.sidecarYes': '有清单',
      'snapTab.sidecarNo': '无清单',
      'snapTab.archiveCount': '另有 {n} 份归档在 _archive',
      'snapTab.empty': '云端还没有快照',
      'snapTab.emptyBody': '点「立即备份」把当前配置上传到网盘，成功后可在此查看与还原。',
      'snapTab.detail': '快照详情',
      'snapTab.noSelection': '选择上方快照以查看清单、差异与还原选项。',
      'snapTab.preview': '查看内容',
      'snapTab.previewLoading': '读取清单中…',
      'snapTab.previewError': '读取清单失败',
      'snapTab.oldSnapshot': '旧快照无清单，将直接下载预览',
      'snapTab.previewMissing': '清单不可用，将直接下载快照预览',
      'snapTab.manifest': 'MANIFEST',
      'snapTab.manifestSource': '来源 {source}',
      'snapTab.manifestFiles': '{n} 文件',
      'snapTab.manifestSize': '约 {size}',
      'snapTab.manifestPartial': '标记为不完整（partial）',
      'snapTab.manifestEntries': '条目汇总',
      'snapTab.manifestEntry': '{files} 文件 / {bytes}',
      'snapTab.manifestTruncated': '共 {n} 个条目，仅显示前 {shown} 个',
      'snapTab.restoreScope': '还原范围',
      'snapTab.scopeAll': '整包',
      'snapTab.scopeConfig': '仅配置（dsh-home）',
      'snapTab.scopeWorkspace': '仅插件工程（workspace）',
      'snapTab.scopeAllHint': '覆盖 DSH 配置、技能与插件工程的完整还原。',
      'snapTab.scopeConfigHint': '只还原 DSH 的配置与技能目录，不动插件工程。',
      'snapTab.scopeWorkspaceHint': '只还原插件工程代码，不动 DSH 配置。',
      'snapTab.includeSelf': '连同维护插件一起还原',
      'snapTab.includeSelfHint': '默认关闭：避免用旧快照覆盖当前维护插件本身。',
      'snapTab.includeSelfWarn': '已开启：快照中的维护插件会覆盖当前插件目录，可能导致插件回退或本次改动丢失。仅在确认快照版本可兼容时使用。',
      'snapTab.stage': '生成差异',
      'snapTab.staging': '正在下载并计算差异…',
      'snapTab.stagingHint': '快照约 12MB，下载可能需要几十秒，请保持页面打开。',
      'snapTab.stagingElapsed': '已用时 {time}',
      'snapTab.stageError': '生成差异失败',
      'snapTab.diff': '差异预览',
      'snapTab.diffAdded': '新增',
      'snapTab.diffOverwritten': '覆盖',
      'snapTab.diffDeleted': '删除',
      'snapTab.diffUnchanged': '未变',
      'snapTab.diffBytes': '新增 {added} · 覆盖 {overwritten} · 删除 {deleted}',
      'snapTab.diffTargets': '目标位置',
      'snapTab.diffProtected': '受保护（不会被还原删除）',
      'snapTab.diffWarnings': '差异警告',
      'snapTab.samplesLimit': '仅显示前 {n} 条',
      'snapTab.noDiff': '没有差异',
      'snapTab.apply': '确认还原',
      'snapTab.applying': '正在还原…',
      'snapTab.discard': '放弃暂存',
      'snapTab.busyBackup': '备份进行中，暂时不能还原',
      'snapTab.busyRestore': '还原进行中，请等待完成',
      'snapTab.staleDiff': '还原选项已改变，请重新生成差异',
      'snapTab.confirmTitle': '确认还原',
      'snapTab.confirmBody': '将把快照 {name} 还原到本机，范围：{scope}。还原前会自动创建本地安全副本。',
      'snapTab.confirmEffects': '将影响以下位置',
      'snapTab.confirmType': '输入「恢复」两个字以确认',
      'snapTab.confirmPlaceholder': '恢复',
      'snapTab.appliedTitle': '还原已应用，需要重启 DSH',
      'snapTab.appliedBody': '配置与插件文件已写入本机，重启 DSH 后生效。重启会断开当前 Web 会话。',
      'snapTab.appliedManual': '手动重启：完全退出 DSH（⌘Q）后重新打开；也可以在「设置」页点「重启 DSH」。',
      'snapTab.appliedTotals': '已写入 {files} 文件 / {bytes}',
      'snapTab.selfSkipped': '维护插件自身已跳过还原（当前插件目录未被覆盖）',
      'snapTab.safetyPath': '安全副本',
      'snapTab.safetyNone': '未返回安全副本路径',
      'snapTab.rollback': '回滚到还原前',
      'snapTab.rollbackTitle': '确认回滚',
      'snapTab.rollbackBody': '将用安全副本覆盖当前文件，撤销本次还原。回滚后同样需要重启 DSH。',
      'snapTab.rollbackCheck': '我已了解，回滚会覆盖当前文件',
      'snapTab.rollbackDone': '已回滚，请重启 DSH 使更改生效。',
      'snapTab.rollbackFailed': '回滚失败',

      'banner.pendingApplying': '上次还原未完成',
      'banner.pendingApplyingBody': '快照 {name} 在应用阶段中断，本地文件可能处于部分更新状态，请检查后重试或回滚。',
      'banner.pendingApplied': '上次还原已完成，等待重启',
      'banner.pendingAppliedBody': '快照 {name} 已于 {time} 应用，重启 DSH 后生效。',
      'banner.lastApplied': '上次还原已完成',
      'banner.lastAppliedBody': '快照 {name} 已于 {time} 应用，重启 DSH 后生效；如有异常可回滚到安全副本。',
      'banner.lastRolledBack': '上次还原已回滚',
      'banner.lastRolledBackBody': '已于 {time} 用安全副本回滚，重启 DSH 后生效。',
      'banner.lastInterrupted': '上次还原在应用阶段中断',
      'banner.lastInterruptedBody': '本地文件可能处于部分更新状态，请检查配置后重试或回滚。',
      'banner.pendingClear': '清除提示',
      'banner.pendingTargets': '影响位置：{targets}',

      'set.schedule': '定时备份',
      'set.enabled': '启用定时备份',
      'set.enabledHint': '关闭后仅保留手动「立即备份」与文件监听。',
      'set.interval': '备份间隔',
      'set.interval.15': '每 15 分钟',
      'set.interval.60': '每 1 小时',
      'set.interval.360': '每 6 小时',
      'set.interval.1440': '每 24 小时',
      'set.interval.generic': '每 {n} 分钟',
      'set.keep': '保留份数',
      'set.keepHint': '云端最多保留 {n} 份完整快照，超出的归档到 _archive。',
      'set.watch': '文件监听',
      'set.watchHint': '监听配置与技能目录变更，变更后自动触发备份。',
      'set.debounce': '变更防抖',
      'set.debounce.30': '30 秒',
      'set.debounce.60': '60 秒',
      'set.debounce.120': '120 秒',
      'set.debounce.300': '300 秒',
      'set.debounce.generic': '{n} 秒',
      'set.save': '保存设置',
      'set.saved': '已保存设置。',
      'set.savedProfile': '已保存，并写入 profile 的 cordis.patch.yml，会随快照一起备份。',
      'set.savedLocal': '已保存到本地运行态（~/.dsh-maintenance/state.json），未写入 profile。',
      'set.dirty': '有未保存的修改',
      'set.restart': '重启 DSH',
      'set.restartHint': '重启会短暂断开当前 Web 会话，插件与面板会重新加载。',
      'set.restartTitle': '确认重启 DSH',
      'set.restartBody': '当前会话会被断开，正在运行的任务可能中断。请先保存工作。',
      'set.restartCheck': '我已保存工作，确认重启',
      'set.restartRequested': '已请求重启，页面可能很快断开。',
      'set.restartFailed': '重启请求失败',
      'set.logs': '运行日志',
      'set.logsRefresh': '刷新日志',
      'set.logsLoading': '读取日志…',
      'set.logsEmpty': '暂无日志',
      'set.logsLines': '最近 {n} 行',
      'set.logsError': '读取日志失败',
      'set.diag': '诊断信息',
      'set.diagDataDir': '运行态目录',
      'set.diagSyncDir': '同步目录',
      'set.diagVersion': '版本',

      'state.loading': '正在读取状态…',
      'state.errorTitle': '无法读取状态',
      'state.errorBody': '插件 Host 半可能尚未启动，或接口暂不可用。',

      'unit.ms': 'ms',
      'unit.second': '秒',
      'unit.minute': '分',
      'unit.hour': '小时',
      'unit.day': '天',
      'time.soon': '即将开始',
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',
      'time.unknown': '未知',
      'lock.backup': '备份',
      'lock.restore': '还原',
    };

    const en = {
      'entry.label': 'Cloud Backup',
      'page.title': 'Cloud Backup',
      'page.subtitle': 'Back up DSH config, skills and local plugin projects to Quark Drive',
      'page.aria': 'Cloud backup maintenance panel',
      'action.backup': 'Back up now',
      'action.backupBusy': '{stage} {progress}%',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'action.saving': 'Saving…',
      'action.confirm': 'Confirm',
      'action.dismiss': 'Dismiss',
      'action.select': 'Select',

      'tab.overview': 'Overview',
      'tab.scope': 'Scope',
      'tab.snapshots': 'Snapshots & Restore',
      'tab.settings': 'Settings',
      'tabs.aria': 'Maintenance sections',

      'header.busyBackup': 'Backing up',
      'header.busyRestore': 'Restoring',
      'card.connection': 'Quark connection',
      'card.lastBackup': 'Last backup',
      'card.snapshots': 'Cloud snapshots',
      'card.nextBackup': 'Next automatic backup',

      'conn.state.connected': 'Connected',
      'conn.state.unauthorized': 'Unauthorized',
      'conn.state.error': 'Network error',
      'conn.state.unknown': 'Checking',
      'conn.nickname': 'Account',
      'conn.nicknameUnknown': 'No nickname returned',
      'conn.vip': 'Membership',
      'conn.usage': 'Used {used} of {total}',
      'conn.expires': 'Expires {date}',
      'conn.expiresUnknown': 'Expiry unknown',
      'conn.checked': 'Checked {time}',
      'conn.stale': 'Cached data — recheck for the latest state',
      'conn.retry': 'Recheck',
      'conn.retrying': 'Checking…',
      'conn.reauth.title': 'Re-authorize',
      'conn.reauth.body': 'Paste the Quark auth code to sign in. It is used for this login only and never leaves the machine.',
      'conn.reauth.placeholder': 'Auth code',
      'conn.reauth.submit': 'Sign in',
      'conn.reauth.submitting': 'Signing in…',
      'conn.reauth.hint': 'Terminal fallback: run the command below; it opens the browser and blocks until authorization finishes.',
      'conn.reauth.command': 'node ~/.dsh/skills/quarkclouddrive/scripts/quark-drive.cjs login',
      'conn.reauth.commandNote': 'After authorizing, come back and press Recheck.',
      'conn.error.retry': 'Retry connection',

      'last.meta': '{time} · took {duration}',
      'last.metaSize': '{size} · {files} files',
      'last.metaSizeOnly': 'snapshot {size}',
      'snap.meta': 'keeps the latest {n}',
      'snap.archived': '{n} more archived in _archive',
      'next.every': '{time} · {interval}',
      'ov.healthy': 'All good',
      'ov.healthyBody': 'No warnings — backups run on schedule.',
      'ov.attention': '{n} items need attention',
      'ov.policy': 'Schedule',
      'last.never': 'No backup yet',
      'last.neverHint': 'Press "Back up now" to create the first cloud snapshot.',
      'last.time': 'Time',
      'last.duration': 'Duration',
      'last.files': 'Files',
      'last.size': 'Size',
      'last.running': '{stage} · {progress}%',
      'last.error': 'Reason',
      'last.partial': 'Partial snapshot (some folders unreadable)',

      'result.success': 'Success',
      'result.skipped': 'Skipped',
      'result.failed': 'Failed',
      'result.running': 'Running',
      'result.unknown': 'Unknown',

      'snap.count': '{n} snapshots',
      'snap.keep': 'keep {n}',
      'snap.archive': 'The _archive folder is never cleaned automatically — empty it in the Quark app',
      'snap.loading': 'Counting…',
      'snap.unknown': 'Not counted yet',
      'snap.open': 'View snapshots',

      'next.off': 'Disabled',
      'next.waiting': 'Enabled, waiting for schedule',
      'next.countdown': 'in {countdown}',
      'next.at': '{time}',
      'next.watchOn': 'Watch mode: back up on change ({n}s debounce)',
      'next.watchOff': 'Watch mode: off',
      'next.hint': 'Scheduled backups are off — enable them in Settings',
      'next.open': 'Open settings',

      'ov.summary': 'Summary',
      'ov.connectionRow': 'Connection',
      'ov.lastRow': 'Last backup',
      'ov.scheduleRow': 'Schedule',
      'ov.warnings': 'Warnings',
      'ov.warningsEmpty': 'No warnings right now.',
      'ov.protected': 'Never backed up / protected',
      'ov.protectedIntro': 'These paths never enter a snapshot and are never deleted or overwritten by a restore:',
      'ov.tips': 'Notes',
      'ov.scheduleOff': 'Scheduled backups are off (manual backup still works)',
      'ov.watchOn': 'File watching is on — changes trigger a backup after {n}s',
      'ov.watchOff': 'File watching is off',
      'ov.scopeLine': '{files} files / {bytes}',
      'ov.scopeRow': 'Backup scope',
      'ov.scopeUnknown': 'Scope not scanned yet — open the Scope tab',
      'ov.lock': 'A {kind} task is running',
      'p.credentials': 'Credential files stay local and never enter a snapshot.',
      'p.sessions': 'Session history is large and private — never backed up.',
      'p.cache': 'Caches and runtime storage are rebuildable — never backed up.',
      'p.storages': 'Local storage and attachments — never backed up.',
      'p.nodeModules': 'Dependency folders; reinstall after a restore.',
      'p.git': 'Version-control folders, kept out to avoid polluting repos.',
      'p.quark': 'Quark skill runtime (login state, task records, upload queue).',
      'ov.tipPath': 'Absolute paths may differ after restoring on another machine; the plugin maps by hostname and path when it can — check manually when they do not match.',
      'ov.tipPnpm': 'If a plugin project was restored, run the command in that folder to restore dependencies (node_modules is not backed up).',
      'ov.tipLaunchd': 'If this machine used a launchd timer, unload the old plist first and let this plugin own the schedule.',
      'ov.tipPnpmCommand': 'pnpm install',
      'ov.tipLaunchdCommand': 'launchctl unload ~/Library/LaunchAgents/*.plist',

      'scope.title': 'Backup scope',
      'scope.subtitle': 'Each entry packs a local path to a destination path inside the archive; disable any entry individually.',
      'scope.refresh': 'Rescan scope',
      'scope.loading': 'Scanning backup scope…',
      'scope.error': 'Could not read the backup scope',
      'scope.col.name': 'Item',
      'scope.col.local': 'Local path',
      'scope.col.dest': 'Archive path',
      'scope.col.files': 'Files',
      'scope.col.bytes': 'Size',
      'scope.col.readable': 'Readable',
      'scope.col.discovered': 'Found',
      'scope.col.enabled': 'Enabled',
      'scope.readable': 'Readable',
      'scope.unreadable': 'Unreadable',
      'scope.missing': 'Path missing',
      'scope.discovered': 'Auto-discovered',
      'scope.empty': 'Nothing to back up',
      'scope.emptyBody': 'Check the configured backup paths, then rescan.',
      'scope.excluded': 'Not backed up / excluded ({n})',
      'scope.notes': 'Scan notes',
      'scope.totals': '{enabled}/{total} entries enabled, {files} files / {bytes}',
      'scope.unreadableCount': '{n} unreadable',
      'scope.toggleFailed': 'Toggle failed — reverted',
      'scope.busyHint': 'A task is running — the backup scope is locked for now',

      'snapTab.title': 'Snapshots & restore',
      'snapTab.subtitle': 'Inspect the manifest and stage a diff before applying the two-phase restore.',
      'snapTab.refresh': 'Refresh snapshots',
      'snapTab.loading': 'Loading cloud snapshots…',
      'snapTab.error': 'Could not load snapshots',
      'snapTab.col.name': 'Snapshot',
      'snapTab.col.date': 'Date',
      'snapTab.col.size': 'Size',
      'snapTab.col.state': 'State',
      'snapTab.col.sidecar': 'Manifest',
      'snapTab.col.actions': '',
      'snapTab.complete': 'Complete',
      'snapTab.incomplete': 'Incomplete',
      'snapTab.sidecarYes': 'Sidecar',
      'snapTab.sidecarNo': 'None',
      'snapTab.archiveCount': '{n} archived in _archive',
      'snapTab.empty': 'No snapshots in the cloud yet',
      'snapTab.emptyBody': 'Press "Back up now" to upload the current configuration, then come back to preview and restore it.',
      'snapTab.detail': 'Snapshot detail',
      'snapTab.noSelection': 'Select a snapshot above to see its manifest, diff and restore options.',
      'snapTab.preview': 'View contents',
      'snapTab.previewLoading': 'Reading manifest…',
      'snapTab.previewError': 'Could not read the manifest',
      'snapTab.oldSnapshot': 'Old snapshot has no manifest — previewing downloads it directly',
      'snapTab.previewMissing': 'Manifest unavailable — preview downloads the snapshot directly',
      'snapTab.manifest': 'MANIFEST',
      'snapTab.manifestSource': 'source {source}',
      'snapTab.manifestFiles': '{n} files',
      'snapTab.manifestSize': '~{size}',
      'snapTab.manifestPartial': 'Marked partial',
      'snapTab.manifestEntries': 'Entries',
      'snapTab.manifestEntry': '{files} files / {bytes}',
      'snapTab.manifestTruncated': '{n} entries, showing the first {shown}',
      'snapTab.restoreScope': 'Restore scope',
      'snapTab.scopeAll': 'Everything',
      'snapTab.scopeConfig': 'Config only (dsh-home)',
      'snapTab.scopeWorkspace': 'Plugin workspace only',
      'snapTab.scopeAllHint': 'Full restore: DSH config, skills and plugin projects.',
      'snapTab.scopeConfigHint': 'Only DSH config and skills; plugin projects are untouched.',
      'snapTab.scopeWorkspaceHint': 'Only plugin project code; DSH config is untouched.',
      'snapTab.includeSelf': 'Restore the maintenance plugin too',
      'snapTab.includeSelfHint': 'Off by default so an old snapshot cannot overwrite the plugin running this panel.',
      'snapTab.includeSelfWarn': 'Enabled: the snapshot will overwrite the running maintenance plugin and may roll it back or drop recent changes. Only use it when you are sure the snapshot version is compatible.',
      'snapTab.stage': 'Generate diff',
      'snapTab.staging': 'Downloading and computing the diff…',
      'snapTab.stagingHint': 'Snapshots are around 12MB; the download can take tens of seconds. Keep this page open.',
      'snapTab.stagingElapsed': '{time} elapsed',
      'snapTab.stageError': 'Could not generate the diff',
      'snapTab.diff': 'Diff preview',
      'snapTab.diffAdded': 'Added',
      'snapTab.diffOverwritten': 'Overwritten',
      'snapTab.diffDeleted': 'Deleted',
      'snapTab.diffUnchanged': 'Unchanged',
      'snapTab.diffBytes': '+{added} · ~{overwritten} · -{deleted}',
      'snapTab.diffTargets': 'Targets',
      'snapTab.diffProtected': 'Protected (never deleted by a restore)',
      'snapTab.diffWarnings': 'Diff warnings',
      'snapTab.samplesLimit': 'showing the first {n}',
      'snapTab.noDiff': 'No differences',
      'snapTab.apply': 'Confirm restore',
      'snapTab.applying': 'Restoring…',
      'snapTab.discard': 'Discard staging',
      'snapTab.busyBackup': 'A backup is running — restore is unavailable',
      'snapTab.busyRestore': 'A restore is running — please wait',
      'snapTab.staleDiff': 'Restore options changed — generate the diff again',
      'snapTab.confirmTitle': 'Confirm restore',
      'snapTab.confirmBody': 'Restore snapshot {name} to this machine, scope: {scope}. A local safety copy is created first.',
      'snapTab.confirmEffects': 'These locations will be affected',
      'snapTab.confirmType': 'Type "RESTORE" to confirm',
      'snapTab.confirmPlaceholder': 'RESTORE',
      'snapTab.appliedTitle': 'Restore applied — DSH must restart',
      'snapTab.appliedBody': 'Config and plugin files are written; restart DSH to activate them. Restarting drops the current web session.',
      'snapTab.appliedManual': 'Manual restart: quit DSH completely (⌘Q) and reopen it, or press "Restart DSH" on the Settings tab.',
      'snapTab.appliedTotals': 'Wrote {files} files / {bytes}',
      'snapTab.selfSkipped': 'The maintenance plugin itself was skipped (its folder is untouched)',
      'snapTab.safetyPath': 'Safety copy',
      'snapTab.safetyNone': 'No safety copy path returned',
      'snapTab.rollback': 'Roll back',
      'snapTab.rollbackTitle': 'Confirm rollback',
      'snapTab.rollbackBody': 'The safety copy overwrites the current files and undoes this restore. A restart is required afterwards.',
      'snapTab.rollbackCheck': 'I understand current files will be overwritten',
      'snapTab.rollbackDone': 'Rolled back — restart DSH to apply.',
      'snapTab.rollbackFailed': 'Rollback failed',

      'banner.pendingApplying': 'Previous restore did not finish',
      'banner.pendingApplyingBody': 'Snapshot {name} was interrupted while applying; local files may be partially updated. Review, retry or roll back.',
      'banner.pendingApplied': 'Previous restore finished — restart pending',
      'banner.pendingAppliedBody': 'Snapshot {name} was applied at {time}; restart DSH to activate it.',
      'banner.lastApplied': 'Last restore completed',
      'banner.lastAppliedBody': 'Snapshot {name} was applied at {time}; restart DSH to activate it. Roll back to the safety copy if something looks wrong.',
      'banner.lastRolledBack': 'Last restore rolled back',
      'banner.lastRolledBackBody': 'The safety copy was rolled back at {time}; restart DSH to apply.',
      'banner.lastInterrupted': 'Last restore was interrupted while applying',
      'banner.lastInterruptedBody': 'Local files may be partially updated. Review the config, then retry or roll back.',
      'banner.pendingClear': 'Clear notice',
      'banner.pendingTargets': 'Affected: {targets}',

      'set.schedule': 'Scheduled backup',
      'set.enabled': 'Enable scheduled backup',
      'set.enabledHint': 'When off, only manual backup and file watching remain.',
      'set.interval': 'Interval',
      'set.interval.15': 'Every 15 minutes',
      'set.interval.60': 'Every hour',
      'set.interval.360': 'Every 6 hours',
      'set.interval.1440': 'Every 24 hours',
      'set.interval.generic': 'Every {n} minutes',
      'set.keep': 'Snapshots to keep',
      'set.keepHint': 'Keep at most {n} complete snapshots; older ones are archived to _archive.',
      'set.watch': 'File watching',
      'set.watchHint': 'Watch config and skill folders and back up after changes.',
      'set.debounce': 'Change debounce',
      'set.debounce.30': '30 s',
      'set.debounce.60': '60 s',
      'set.debounce.120': '120 s',
      'set.debounce.300': '300 s',
      'set.debounce.generic': '{n} s',
      'set.save': 'Save settings',
      'set.saved': 'Settings saved.',
      'set.savedProfile': 'Saved into the profile cordis.patch.yml, so it is included in snapshots.',
      'set.savedLocal': 'Saved to the local runtime state (~/.dsh-maintenance/state.json), not the profile.',
      'set.dirty': 'Unsaved changes',
      'set.restart': 'Restart DSH',
      'set.restartHint': 'Restarting briefly drops the current web session; the plugin and this panel reload afterwards.',
      'set.restartTitle': 'Restart DSH?',
      'set.restartBody': 'The current session disconnects and running tasks may be interrupted. Save your work first.',
      'set.restartCheck': 'I saved my work and want to restart',
      'set.restartRequested': 'Restart requested; the page may disconnect shortly.',
      'set.restartFailed': 'Restart request failed',
      'set.logs': 'Runtime log',
      'set.logsRefresh': 'Refresh log',
      'set.logsLoading': 'Reading log…',
      'set.logsEmpty': 'No log lines yet',
      'set.logsLines': 'last {n} lines',
      'set.logsError': 'Could not read the log',
      'set.diag': 'Diagnostics',
      'set.diagDataDir': 'Runtime dir',
      'set.diagSyncDir': 'Sync dir',
      'set.diagVersion': 'Version',

      'state.loading': 'Loading status…',
      'state.errorTitle': 'Could not load status',
      'state.errorBody': 'The plugin host half may not be running yet, or the API is unavailable.',

      'unit.ms': 'ms',
      'unit.second': 's',
      'unit.minute': 'm',
      'unit.hour': 'h',
      'unit.day': 'd',
      'time.soon': 'starting soon',
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.daysAgo': '{n} d ago',
      'time.unknown': 'unknown',
      'lock.backup': 'backup',
      'lock.restore': 'restore',
    };

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
          // Locale service may be unavailable in tests; default to Chinese.
        }
        return 'zh';
      }
      function translate(key, values) {
        const dict = DICTS[currentLocale()] || zh;
        let text = dict[key] ?? en[key] ?? key;
        if (values) {
          for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
        }
        return text;
      }
      translate.currentLocale = currentLocale;
      return translate;
    }

    // ---------------------------------------------------------------------------------------
    // Formatting helpers
    // ---------------------------------------------------------------------------------------

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function num(...values) {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
      return null;
    }

    function messageOf(error) {
      if (!error) return '';
      if (typeof error === 'string') return error;
      if (typeof error.message === 'string' && error.message) return error.message;
      return String(error);
    }

    function formatBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1000) return `${Math.round(bytes)} B`;
      const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
      let size = bytes / 1024;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      const digits = size < 10 ? 2 : size < 100 ? 1 : 0;
      return `${size.toFixed(digits)} ${units[index]}`;
    }

    function formatInt(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return '—';
      return Math.round(number).toLocaleString('en-US');
    }

    function formatDateTime(epochMs) {
      const time = Number(epochMs);
      if (!Number.isFinite(time) || time <= 0) return '';
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '';
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatClock(epochMs) {
      const time = Number(epochMs);
      if (!Number.isFinite(time) || time <= 0) return '';
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '';
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    function formatRelative(epochMs, now, t) {
      const time = Number(epochMs);
      if (!Number.isFinite(time) || time <= 0) return t('time.unknown');
      const deltaMs = Number(now || Date.now()) - time;
      if (deltaMs < 0) return formatCountdown(-deltaMs, t);
      if (deltaMs < 45_000) return t('time.justNow');
      const minutes = Math.round(deltaMs / 60_000);
      if (minutes < 60) return t('time.minutesAgo', { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t('time.hoursAgo', { n: hours });
      return t('time.daysAgo', { n: Math.round(hours / 24) });
    }

    function formatDuration(ms, t) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      if (ms < 1000) return `${Math.max(1, Math.round(ms))}${t('unit.ms')}`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}${t('unit.second')}`;
      const wholeMinutes = Math.floor(seconds / 60);
      const restSeconds = Math.round(seconds % 60);
      if (wholeMinutes < 60) {
        return restSeconds > 0 ? `${wholeMinutes}${t('unit.minute')} ${restSeconds}${t('unit.second')}` : `${wholeMinutes}${t('unit.minute')}`;
      }
      const hours = Math.floor(wholeMinutes / 60);
      return `${hours}${t('unit.hour')} ${wholeMinutes % 60}${t('unit.minute')}`;
    }

    function formatCountdown(ms, t) {
      if (!Number.isFinite(ms)) return '—';
      const totalSeconds = Math.floor(Math.abs(ms) / 1000);
      if (totalSeconds < 1) return t('time.soon');
      const days = Math.floor(totalSeconds / 86400);
      const hours = Math.floor((totalSeconds % 86400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const parts = [];
      if (days > 0) {
        parts.push(`${days}${t('unit.day')}`);
        if (hours > 0) parts.push(`${hours}${t('unit.hour')}`);
      } else if (hours > 0) {
        parts.push(`${hours}${t('unit.hour')}`);
        if (minutes > 0) parts.push(`${minutes}${t('unit.minute')}`);
      } else {
        if (minutes > 0) parts.push(`${minutes}${t('unit.minute')}`);
        parts.push(`${seconds}${t('unit.second')}`);
      }
      return parts.join(' ');
    }

    function intervalLabel(minutes, t) {
      const key = `set.interval.${minutes}`;
      const text = t(key);
      return text === key ? t('set.interval.generic', { n: minutes }) : text;
    }

    function debounceLabel(seconds, t) {
      const key = `set.debounce.${seconds}`;
      const text = t(key);
      return text === key ? t('set.debounce.generic', { n: seconds }) : text;
    }

    function resultKey(value) {
      if (value === 'success' || value === 'skipped' || value === 'failed') return value;
      return 'unknown';
    }

    function normalizeResult(value) {
      if (value === 'success' || value === true) return 'success';
      if (value === 'skipped') return 'skipped';
      if (value === 'failed' || value === 'error' || value === false) return 'failed';
      return null;
    }

    function isTaskRunning(task) {
      return Boolean(task && task.phase === 'running');
    }

    function busyKindOf(overview) {
      if (!overview) return null;
      const locked = overview.lock?.kind;
      if (locked === 'backup' || locked === 'restore') return locked;
      if (isTaskRunning(overview.backup?.task)) return 'backup';
      if (isTaskRunning(overview.restore?.task)) return 'restore';
      return null;
    }

    /** The host's `last` objects are loosely shaped; read them defensively. */
    function readLastBackup(last) {
      if (!last || typeof last !== 'object') return null;
      // host keeps { ok, skipped, snapshotName, sizeMB, archived, durationMs, partial, error, stageLabel }
      const skipped = last.skipped === true;
      const okFlag = typeof last.ok === 'boolean' ? last.ok : null;
      const result =
        normalizeResult(last.result) ||
        normalizeResult(last.phase) ||
        normalizeResult(last.status) ||
        (skipped ? 'skipped' : okFlag === false || last.error ? 'failed' : 'success');
      const finishedAt = num(last.finishedAt, last.at, last.time, last.completedAt);
      const startedAt = num(last.startedAt);
      const durationMs =
        num(last.durationMs, last.duration) ?? (finishedAt !== null && startedAt !== null ? Math.max(0, finishedAt - startedAt) : null);
      const sizeMB = num(last.sizeMB);
      const files =
        num(last.files, last.fileCount, last.totalFiles, last.result?.files, last.result?.fileCount) ?? null;
      const bytes =
        num(last.bytes, last.size, last.totalBytes, last.result?.bytes, last.result?.size) ??
        (sizeMB !== null ? Math.round(sizeMB * 1024 * 1024) : null);
      const name =
        (typeof last.name === 'string' && last.name) ||
        (typeof last.snapshotName === 'string' && last.snapshotName) ||
        (typeof last.result?.name === 'string' && last.result.name) ||
        null;
      return {
        at: finishedAt ?? startedAt,
        durationMs,
        files,
        bytes,
        result,
        name,
        partial: last.partial === true,
        error: typeof last.error === 'string' ? last.error : null,
      };
    }

    function totalOf(scope) {
      if (!scope || !Array.isArray(scope.entries)) return null;
      let files = 0;
      let bytes = 0;
      for (const entry of scope.entries) {
        if (entry.disabled) continue;
        files += Number(entry.files) || 0;
        bytes += Number(entry.bytes) || 0;
      }
      return { files, bytes };
    }

    // ---------------------------------------------------------------------------------------
    // API — loopback JSON, relative paths, {ok:true,...} envelope
    // ---------------------------------------------------------------------------------------

    async function requestJson(path, options = {}) {
      const { method = 'GET', body, signal } = options;
      const init = {
        method,
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const fallback = `HTTP ${response.status}`;
        throw new Error(payload && typeof payload.error === 'string' && payload.error ? payload.error : fallback);
      }
      return payload;
    }

    const api = {
      overview: (signal) => requestJson(`${API_BASE}/overview`, { signal }),
      scope: (refresh) => requestJson(`${API_BASE}/scope${refresh ? '?refresh=1' : ''}`),
      toggleScope: (src, enabled) => requestJson(`${API_BASE}/scope/toggle`, { method: 'POST', body: { src, enabled } }),
      refreshConnection: () => requestJson(`${API_BASE}/connection/refresh`, { method: 'POST' }),
      login: (token) => requestJson(`${API_BASE}/connection/login`, { method: 'POST', body: { token } }),
      startBackup: (force) => requestJson(`${API_BASE}/backup/start`, { method: 'POST', body: force ? { force: true } : {} }),
      cancelBackup: () => requestJson(`${API_BASE}/backup/cancel`, { method: 'POST' }),
      snapshots: (refresh) => requestJson(`${API_BASE}/snapshots${refresh ? '?refresh=1' : ''}`),
      previewSnapshot: (name) => requestJson(`${API_BASE}/snapshots/preview`, { method: 'POST', body: { name } }),
      stageRestore: (name, scope, includeSelf) =>
        requestJson(`${API_BASE}/restore/stage`, { method: 'POST', body: { name, scope, includeSelf } }),
      applyRestore: (stagingId, scope, includeSelf) =>
        requestJson(`${API_BASE}/restore/apply`, { method: 'POST', body: { stagingId, scope, includeSelf } }),
      discardRestore: (stagingId) => requestJson(`${API_BASE}/restore/discard`, { method: 'POST', body: { stagingId } }),
      rollback: () => requestJson(`${API_BASE}/restore/rollback`, { method: 'POST' }),
      ackRestore: () => requestJson(`${API_BASE}/restore/ack`, { method: 'POST' }),
      logs: (lines) => requestJson(`${API_BASE}/logs?lines=${lines}`),
      saveSchedule: (schedule) => requestJson(`${API_BASE}/schedule`, { method: 'POST', body: schedule }),
      restart: () => requestJson(`${API_BASE}/restart`, { method: 'POST', body: { confirm: true } }),
    };

    // ---------------------------------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------------------------------

    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
      }, [intervalMs]);
      return now;
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

    /** Polls /overview: 1.5s while a task runs, 10s otherwise. Cleans up timer + in-flight fetches. */
    function useOverviewPolling() {
      const [overview, setOverview] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const mountedRef = useRef(true);
      const inFlightRef = useRef(false);
      const controllersRef = useRef(new Set());
      const runningRef = useRef(false);
      const timerRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          for (const controller of controllersRef.current) {
            try {
              controller.abort();
            } catch {
              // ignore
            }
          }
          controllersRef.current.clear();
        };
      }, []);

      const queuedRef = useRef(null);
      const load = useCallback(async () => {
        if (inFlightRef.current) {
          // The in-flight poll may predate the action that asked for a reload (start backup,
          // save policy…): run once more right after it instead of silently dropping the request.
          if (!queuedRef.current) {
            queuedRef.current = new Promise((resolve) => {
              const wait = () => {
                if (inFlightRef.current) {
                  setTimeout(wait, 60);
                  return;
                }
                queuedRef.current = null;
                resolve(load());
              };
              setTimeout(wait, 60);
            });
          }
          return queuedRef.current;
        }
        inFlightRef.current = true;
        const controller = new AbortController();
        controllersRef.current.add(controller);
        try {
          const payload = await api.overview(controller.signal);
          if (!mountedRef.current) return;
          setOverview(payload);
          setError(null);
        } catch (caught) {
          if (!mountedRef.current || controller.signal.aborted) return;
          setError(messageOf(caught));
        } finally {
          controllersRef.current.delete(controller);
          inFlightRef.current = false;
          if (mountedRef.current) setLoading(false);
        }
      }, []);

      runningRef.current = Boolean(busyKindOf(overview));

      useEffect(() => {
        let stopped = false;
        const tick = async () => {
          timerRef.current = null;
          await load();
          if (stopped || !mountedRef.current) return;
          timerRef.current = setTimeout(tick, runningRef.current ? POLL_RUNNING_MS : POLL_IDLE_MS);
        };
        tick();
        return () => {
          stopped = true;
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      }, [load]);

      return { overview, error, loading, reload: load };
    }

    // ---------------------------------------------------------------------------------------
    // Icons — artwork uses currentColor only
    // ---------------------------------------------------------------------------------------

    function SvgIcon({ size = 13, strokeWidth = 1.4, panelEntry, rotate, children }) {
      return h(
        'svg',
        {
          ...(panelEntry ? { 'data-dsh-panel-entry': PANEL_ID } : null),
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none', transform: rotate ? 'rotate(90deg)' : undefined, transition: 'transform .12s ease' },
        },
        children,
      );
    }

    const svgPath = (d) => h('path', { d });

    function MaintenanceIcon({ size = 20 }) {
      return h(
        SvgIcon,
        { size, panelEntry: true, strokeWidth: 1.3 },
        svgPath('M4.2 11.7h7.6a2.6 2.6 0 0 0 .5-5.15A4.4 4.4 0 0 0 5.3 5.6a3.5 3.5 0 0 0-1.1 6.1Z'),
        svgPath('M8 7.6v4.5'),
        svgPath('m6.3 10.4 1.7 1.8 1.7-1.8'),
      );
    }

    function IconRefresh() {
      return h(SvgIcon, { strokeWidth: 1.5 }, svgPath('M13 7.4a5 5 0 1 0 .2 2'), svgPath('M13.2 3.6v3.9H9.3'));
    }

    function IconBackup() {
      return h(SvgIcon, { strokeWidth: 1.5 }, svgPath('M8 12.5V4.6'), svgPath('m5 7.4 3-3 3 3'), svgPath('M3.2 13.4h9.6'));
    }

    function IconCloud() {
      return h(SvgIcon, null, svgPath('M4.4 12.2h7.2a2.4 2.4 0 0 0 .45-4.75A4.1 4.1 0 0 0 5.5 5.9a3.3 3.3 0 0 0-1.1 6.3Z'));
    }

    function IconLayers() {
      return h(SvgIcon, null, svgPath('m8 2.4 5.2 2.6L8 7.6 2.8 5Z'), svgPath('m2.8 8.2 5.2 2.6 5.2-2.6'), svgPath('m2.8 11.2 5.2 2.6 5.2-2.6'));
    }

    function IconClock() {
      return h(SvgIcon, null, h('circle', { cx: 8, cy: 8, r: 5.4 }), svgPath('M8 4.9V8l2.2 1.4'));
    }

    function IconAlert({ size = 13 }) {
      return h(SvgIcon, { size }, svgPath('M8 2.6 14 13H2Z'), svgPath('M8 6.4v3.1'), svgPath('M8 11.5v.1'));
    }

    function IconCheck({ size = 13 }) {
      return h(SvgIcon, { size, strokeWidth: 1.7 }, svgPath('m3.4 8.3 3 3 6.2-6.5'));
    }

    function IconClose() {
      return h(SvgIcon, { size: 12, strokeWidth: 1.6 }, svgPath('m4 4 8 8M12 4l-8 8'));
    }

    function IconChevron({ open }) {
      return h(SvgIcon, { size: 11, strokeWidth: 1.8, rotate: open }, svgPath('M6 3.5 10.5 8 6 12.5'));
    }

    function Spinner({ size = 12 }) {
      return h('span', { className: 'mb-spinner', style: { width: size, height: size }, 'aria-hidden': 'true' });
    }

    // ---------------------------------------------------------------------------------------
    // Atoms
    // ---------------------------------------------------------------------------------------

    function Btn({ variant = 'default', size, busy, disabled, onClick, title, type = 'button', children }) {
      const classes = ['mb-btn'];
      if (variant === 'primary') classes.push('mb-btn-primary');
      if (variant === 'danger') classes.push('mb-btn-danger');
      if (variant === 'ghost') classes.push('mb-btn-ghost');
      if (size === 'sm') classes.push('mb-btn-sm');
      return h(
        'button',
        {
          type,
          className: classes.join(' '),
          onClick,
          disabled: Boolean(disabled || busy),
          title,
          'aria-busy': busy ? 'true' : undefined,
        },
        busy ? h(Spinner, { size: size === 'sm' ? 10 : 11 }) : null,
        typeof children === 'string' ? h('span', null, children) : children,
      );
    }

    function Dot({ tone = 'muted', pulse }) {
      return h('span', { className: `mb-dot mb-dot-${tone}${pulse ? ' is-pulse' : ''}`, 'aria-hidden': 'true' });
    }

    function Chip({ tone = 'neutral', children, title }) {
      return h('span', { className: `mb-chip mb-chip-${tone}`, title }, children);
    }

    function CapacityBar({ ratio, tone }) {
      const percent = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)));
      return h(
        'div',
        { className: 'mb-bar', role: 'progressbar', 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        h('span', { className: `mb-bar-fill${tone === 'warn' ? ' is-warn' : ''}`, style: { width: `${percent}%` } }),
      );
    }

    function Switch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(checked),
        'aria-label': label,
        title: label,
        className: 'mb-switch',
        disabled: Boolean(disabled),
        onClick: (event) => {
          event.stopPropagation();
          if (!disabled) onChange(!checked);
        },
        onKeyDown: (event) => event.stopPropagation(),
      });
    }

    function RadioGroup({ value, options, onChange, label, disabled }) {
      return h(
        'div',
        { className: 'mb-radios', role: 'radiogroup', 'aria-label': label },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'radio',
              'aria-checked': value === option.value,
              className: `mb-radio${value === option.value ? ' is-active' : ''}`,
              onClick: () => {
                if (!disabled) onChange(option.value);
              },
              disabled: Boolean(disabled),
            },
            h('span', { className: 'mb-radio-mark', 'aria-hidden': 'true' }),
            h(
              'span',
              { className: 'mb-radio-text' },
              h('span', { className: 'mb-radio-label' }, option.label),
              option.hint ? h('span', { className: 'mb-radio-hint' }, option.hint) : null,
            ),
          ),
        ),
      );
    }

    function SelectField({ label, value, options, onChange, disabled, hint }) {
      return h(
        'label',
        { className: 'mb-field' },
        h('span', { className: 'mb-field-label' }, label),
        h(
          'select',
          { className: 'mb-select', value, disabled: Boolean(disabled), onChange: (event) => onChange(event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
        hint ? h('span', { className: 'mb-field-hint' }, hint) : null,
      );
    }

    function Card({ title, icon, meta, action, children, className }) {
      return h(
        'div',
        { className: `mb-card${className ? ` ${className}` : ''}` },
        h(
          'div',
          { className: 'mb-card-head' },
          h('div', { className: 'mb-card-title' }, icon ? h('span', { className: 'mb-card-icon' }, icon) : null, h('span', { className: 'mb-ellipsis' }, title)),
          meta ? h('div', { className: 'mb-card-meta' }, meta) : null,
          action ? h('div', { className: 'mb-card-action' }, action) : null,
        ),
        h('div', { className: 'mb-card-body' }, children),
      );
    }

    function InlineError({ message, onRetry, retryLabel, onDismiss }) {
      if (!message) return null;
      return h(
        'div',
        { className: 'mb-inline-error', role: 'alert' },
        h('span', { className: 'mb-inline-error-text' }, message),
        h(
          'span',
          { className: 'mb-inline-error-actions' },
          onRetry ? h('button', { type: 'button', className: 'mb-linkbtn', onClick: onRetry }, retryLabel) : null,
          onDismiss
            ? h(
                'button',
                { type: 'button', className: 'mb-iconbtn', onClick: onDismiss, 'aria-label': 'dismiss', title: 'dismiss' },
                h(IconClose),
              )
            : null,
        ),
      );
    }

    function Section({ title, meta, children, actions, className }) {
      return h(
        'section',
        { className: `mb-section${className ? ` ${className}` : ''}` },
        h(
          'div',
          { className: 'mb-section-head' },
          h('div', { className: 'mb-section-title' }, title),
          meta ? h('div', { className: 'mb-section-meta' }, meta) : null,
          actions ? h('div', { className: 'mb-section-actions' }, actions) : null,
        ),
        children,
      );
    }

    function KeyVal({ items }) {
      return h(
        'dl',
        { className: 'mb-keyvals' },
        items.map((item) =>
          h(
            'div',
            { className: 'mb-keyval', key: item.key },
            h('dt', { className: 'mb-keyval-key' }, item.key),
            h('dd', { className: 'mb-keyval-value' }, item.value),
          ),
        ),
      );
    }

    function LoadingState({ t, label }) {
      return h('div', { className: 'mb-state' }, h(Spinner, { size: 14 }), h('span', null, label || t('state.loading')));
    }

    function EmptyState({ t, icon, title, body, action }) {
      return h(
        'div',
        { className: 'mb-state mb-state-empty' },
        icon ? h('span', { className: 'mb-state-icon' }, icon) : null,
        h('div', { className: 'mb-state-title' }, title),
        body ? h('div', { className: 'mb-state-body' }, body) : null,
        action || null,
      );
    }

    function ConfirmDialog({
      t,
      title,
      body,
      effects,
      tone = 'default',
      requireText,
      requireLabel,
      requirePlaceholder,
      checkboxLabel,
      confirmLabel,
      busy,
      error,
      onCancel,
      onConfirm,
    }) {
      const [typed, setTyped] = useState('');
      const [checked, setChecked] = useState(false);
      const panelRef = useRef(null);
      useEffect(() => {
        const node = panelRef.current;
        if (node && typeof node.focus === 'function') {
          try {
            node.focus({ preventScroll: true });
          } catch {
            // focus is best-effort
          }
        }
      }, []);
      const textOk = !requireText || typed.trim() === requireText;
      const checkOk = !checkboxLabel || checked;
      const ready = textOk && checkOk;
      const submit = () => {
        if (ready && !busy) onConfirm();
      };
      return h(
        'div',
        {
          className: 'mb-overlay',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busy) onCancel();
          },
        },
        h(
          'div',
          {
            className: 'mb-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            tabIndex: -1,
            ref: panelRef,
            onKeyDown: (event) => {
              if (event.key === 'Escape' && !busy) onCancel();
            },
          },
          h('div', { className: 'mb-dialog-title' }, title),
          body ? h('div', { className: 'mb-dialog-body' }, body) : null,
          effects ? h('div', { className: 'mb-dialog-effects' }, effects) : null,
          requireText
            ? h(
                'label',
                { className: 'mb-field' },
                h('span', { className: 'mb-field-label' }, requireLabel || t('snapTab.confirmType')),
                h('input', {
                  className: 'mb-input',
                  type: 'text',
                  value: typed,
                  autoComplete: 'off',
                  spellCheck: false,
                  placeholder: requirePlaceholder || requireText,
                  'aria-label': requireLabel || t('snapTab.confirmType'),
                  onChange: (event) => setTyped(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submit();
                  },
                }),
              )
            : null,
          checkboxLabel
            ? h(
                'label',
                { className: 'mb-check' },
                h('input', { type: 'checkbox', checked, onChange: (event) => setChecked(event.target.checked) }),
                h('span', null, checkboxLabel),
              )
            : null,
          error ? h('div', { className: 'mb-inline-error' }, h('span', { className: 'mb-inline-error-text' }, error)) : null,
          h(
            'div',
            { className: 'mb-dialog-foot' },
            h('button', { type: 'button', className: 'mb-btn', onClick: onCancel, disabled: Boolean(busy) }, t('action.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: `mb-btn${tone === 'danger' ? ' mb-btn-danger' : ' mb-btn-primary'}`,
                onClick: submit,
                disabled: Boolean(busy) || !ready,
              },
              busy ? h(Spinner, { size: 11 }) : null,
              h('span', null, confirmLabel || t('action.confirm')),
            ),
          ),
        ),
      );
    }

    function Collapsible({ title, meta, children, defaultOpen = false, tone }) {
      const [open, setOpen] = useState(defaultOpen);
      return h(
        'div',
        { className: `mb-collapsible${tone ? ` is-${tone}` : ''}` },
        h(
          'button',
          {
            type: 'button',
            className: 'mb-collapsible-head',
            onClick: () => setOpen((value) => !value),
            'aria-expanded': open,
          },
          h(IconChevron, { open }),
          h('span', { className: 'mb-collapsible-title' }, title),
          meta ? h('span', { className: 'mb-collapsible-meta' }, meta) : null,
        ),
        open ? h('div', { className: 'mb-collapsible-body' }, children) : null,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Status cards
    // ---------------------------------------------------------------------------------------

    function MiniRow({ label, value, hint }) {
      return h(
        'div',
        { className: 'mb-row' },
        h('span', { className: 'mb-row-label' }, label),
        h('span', { className: 'mb-row-value' }, value),
        hint ? h('span', { className: 'mb-row-hint' }, hint) : null,
      );
    }

    function ConnectionCard({ t, connection, onRefreshConnection, onLogin }) {
      const [token, setToken] = useState('');
      const [authBusy, setAuthBusy] = useState(false);
      const [authError, setAuthError] = useState(null);
      const [refreshBusy, setRefreshBusy] = useState(false);
      const [refreshError, setRefreshError] = useState(null);

      const rawState = connection?.state;
      const state = rawState === 'connected' || rawState === 'unauthorized' || rawState === 'error' ? rawState : 'unknown';
      const tone = state === 'connected' ? 'success' : state === 'unauthorized' ? 'warn' : state === 'error' ? 'error' : 'muted';
      const capacity = num(connection?.capacity);
      const used = num(connection?.used);
      const ratio = capacity && capacity > 0 && used !== null ? Math.max(0, Math.min(1, used / capacity)) : null;
      const percent = ratio === null ? null : Math.round(ratio * 100);
      const expiresAt = num(connection?.expiresAt);

      const refresh = async () => {
        if (refreshBusy) return;
        setRefreshBusy(true);
        setRefreshError(null);
        try {
          await onRefreshConnection();
        } catch (caught) {
          setRefreshError(messageOf(caught));
        } finally {
          setRefreshBusy(false);
        }
      };

      const submit = async () => {
        const trimmed = token.trim();
        if (!trimmed || authBusy) return;
        setAuthBusy(true);
        setAuthError(null);
        try {
          await onLogin(trimmed);
          setToken('');
        } catch (caught) {
          setAuthError(messageOf(caught));
        } finally {
          setAuthBusy(false);
        }
      };

      const body = [];
      body.push(
        h(
          'div',
          { className: 'mb-statusline mb-card-value', key: 'status' },
          h(Dot, { tone, pulse: state === 'unknown' || refreshBusy }),
          h('span', { className: `mb-status mb-status-${tone}` }, t(`conn.state.${state}`)),
          percent !== null ? h('span', { className: 'mb-card-value-aside' }, `${percent}%`) : null,
        ),
      );

      if (state === 'connected') {
        body.push(
          h(
            'div',
            { className: 'mb-card-sub', key: 'account' },
            h('span', { className: 'mb-ellipsis', title: connection?.nickname || '' }, connection?.nickname || t('conn.nicknameUnknown')),
            connection?.vipType ? h(Chip, { tone: 'brand', title: t('conn.vip') }, connection.vipType) : null,
          ),
        );
        if (ratio !== null) {
          body.push(
            h(
              'div',
              { className: 'mb-bar-row', key: 'bar' },
              h(CapacityBar, { ratio, tone: ratio > 0.85 ? 'warn' : 'ok' }),
              h('div', { className: 'mb-bar-text' }, t('conn.usage', { used: formatBytes(used), total: formatBytes(capacity) })),
              h(
                'div',
                { className: 'mb-hint' },
                [
                  expiresAt ? t('conn.expires', { date: formatDateTime(expiresAt).slice(0, 10) }) : t('conn.expiresUnknown'),
                  connection?.checkedAt ? t('conn.checked', { time: formatClock(connection.checkedAt) }) : null,
                ].filter(Boolean).join(' · '),
              ),
            ),
          );
        } else {
          body.push(
            h('div', { className: 'mb-hint', key: 'expires' }, expiresAt ? t('conn.expires', { date: formatDateTime(expiresAt) }) : t('conn.expiresUnknown')),
          );
        }
        if (connection?.stale) body.push(h('div', { className: 'mb-hint', key: 'stale' }, t('conn.stale')));
        if (refreshError) {
          body.push(h(InlineError, { key: 'error', message: refreshError, onRetry: refresh, retryLabel: t('action.retry') }));
        }
      } else if (state === 'unauthorized') {
        body.push(h('div', { className: 'mb-hint', key: 'message' }, connection?.message || t('conn.reauth.body')));
        body.push(
          h(
            'div',
            { className: 'mb-reauth', key: 'reauth' },
            h('div', { className: 'mb-reauth-title' }, t('conn.reauth.title')),
            h(
              'div',
              { className: 'mb-reauth-row' },
              h('input', {
                className: 'mb-input',
                type: 'password',
                value: token,
                autoComplete: 'off',
                spellCheck: false,
                placeholder: t('conn.reauth.placeholder'),
                'aria-label': t('conn.reauth.placeholder'),
                onChange: (event) => setToken(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit();
                },
              }),
              h(Btn, { variant: 'primary', size: 'sm', busy: authBusy, disabled: !token.trim(), onClick: submit }, authBusy ? t('conn.reauth.submitting') : t('conn.reauth.submit')),
            ),
            authError ? h(InlineError, { message: authError }) : null,
            h('div', { className: 'mb-hint' }, t('conn.reauth.hint')),
            h('code', { className: 'mb-command' }, t('conn.reauth.command')),
            h('div', { className: 'mb-hint' }, t('conn.reauth.commandNote')),
          ),
        );
      } else if (state === 'error') {
        body.push(h('div', { className: 'mb-hint mb-hint-error', key: 'message' }, connection?.message || refreshError || ''));
        body.push(
          h(
            'div',
            { className: 'mb-inline-actions', key: 'actions' },
            h(Btn, { size: 'sm', busy: refreshBusy, onClick: refresh }, t('conn.error.retry')),
          ),
        );
      } else {
        body.push(
          h(
            'div',
            { className: 'mb-hint', key: 'checking' },
            h(Spinner, { size: 11 }),
            h('span', null, connection?.message || t('state.loading')),
          ),
        );
      }

      return h(Card, {
        title: t('card.connection'),
        icon: h(IconCloud),
        action: h(
          Btn,
          { variant: 'ghost', size: 'sm', busy: refreshBusy, onClick: refresh, title: t('conn.retry') },
          refreshBusy ? t('conn.retrying') : t('conn.retry'),
        ),
        children: body,
      });
    }

    function LastBackupCard({ t, overview }) {
      const task = overview?.backup?.task || null;
      const running = isTaskRunning(task);
      const last = readLastBackup(overview?.backup?.last);
      const result = last ? last.result : null;
      const resultTone = result === 'success' ? 'success' : result === 'failed' ? 'error' : result === 'skipped' ? 'warn' : 'neutral';
      const now = useNow(30_000);
      const meta = running
        ? h(Chip, { tone: 'brand' }, t('result.running'))
        : result
          ? h(Chip, { tone: resultTone }, t(`result.${resultKey(result)}`))
          : null;

      const body = [];
      if (running) {
        const progress = Math.max(0, Math.min(100, Number(task?.progress) || 0));
        body.push(
          h(
            'div',
            { className: 'mb-statusline', key: 'running' },
            h(Spinner, { size: 12 }),
            h('span', { className: 'mb-status' }, t('last.running', { stage: task?.stageLabel || t('result.running'), progress })),
          ),
        );
        body.push(h(CapacityBar, { key: 'progress', ratio: progress / 100, tone: 'ok' }));
        if (task?.startedAt) {
          body.push(h(MiniRow, { key: 'started', label: t('last.time'), value: formatDateTime(task.startedAt), hint: formatRelative(task.startedAt, now, t) }));
        }
      } else if (!last) {
        body.push(h('div', { className: 'mb-hint', key: 'never' }, t('last.never')));
        body.push(h('div', { className: 'mb-hint', key: 'neverHint' }, t('last.neverHint')));
      } else {
        body.push(h('div', { className: 'mb-big', key: 'rel' }, last.at ? formatRelative(last.at, now, t) : t('time.unknown')));
        body.push(
          h(
            'div',
            { className: 'mb-card-sub', key: 'when' },
            t('last.meta', {
              time: last.at ? formatDateTime(last.at) : t('time.unknown'),
              duration: last.durationMs === null ? '—' : formatDuration(last.durationMs, t),
            }),
          ),
        );
        if (last.bytes !== null || last.files !== null) {
          body.push(
            h(
              'div',
              { className: 'mb-hint', key: 'size' },
              last.files === null
                ? t('last.metaSizeOnly', { size: formatBytes(last.bytes) })
                : t('last.metaSize', { size: last.bytes === null ? '—' : formatBytes(last.bytes), files: formatInt(last.files) }),
            ),
          );
        }
        if (last.partial) body.push(h('div', { className: 'mb-hint mb-hint-warn', key: 'partial' }, t('last.partial')));
        if (result === 'failed' && last.error) {
          body.push(h('div', { className: 'mb-hint mb-hint-error', key: 'reason' }, `${t('last.error')}: ${last.error}`));
        }
      }

      return h(Card, { title: t('card.lastBackup'), icon: h(IconClock), meta, children: body });
    }

    function SnapshotsCard({ t, overview, archiveCount, onOpen }) {
      const counts = overview?.counts || {};
      const loading = Boolean(counts.snapshotsLoading);
      const value =
        typeof counts.snapshots === 'number'
          ? t('snap.count', { n: counts.snapshots })
          : loading
            ? t('snap.loading')
            : t('snap.unknown');
      const archive =
        typeof archiveCount === 'number' ? archiveCount : typeof overview?.archiveCount === 'number' ? overview.archiveCount : null;
      const children = [
        h('div', { className: 'mb-big', key: 'value' }, loading && typeof counts.snapshots !== 'number' ? h(Spinner, { size: 12 }) : null, value),
        h('div', { className: 'mb-card-sub', key: 'keep' }, t('snap.meta', { n: overview?.schedule?.keep || 5 })),
        h(
          'div',
          { className: 'mb-hint', key: 'archive', title: t('snap.archive') },
          typeof archive === 'number' && archive > 0 ? t('snap.archived', { n: archive }) : t('snap.archive'),
        ),
      ];
      return h(Card, {
        title: t('card.snapshots'),
        icon: h(IconLayers),
        action: h(Btn, { variant: 'ghost', size: 'sm', onClick: () => onOpen('snapshots') }, t('snap.open')),
        children,
      });
    }

    function NextBackupCard({ t, overview, onOpen }) {
      const schedule = overview?.schedule || null;
      const now = useNow(1000);
      const enabled = Boolean(schedule?.enabled);
      const nextRunAt = num(schedule?.nextRunAt);
      const countdown = enabled && nextRunAt !== null ? nextRunAt - now : null;
      const value = !enabled
        ? t('next.off')
        : nextRunAt === null || countdown === null
          ? t('next.waiting')
          : countdown <= 0
            ? t('time.soon')
            : t('next.countdown', { countdown: formatCountdown(countdown, t) });
      const children = [
        h('div', { className: `mb-big${enabled ? '' : ' is-muted'}`, key: 'value' }, value),
        enabled && nextRunAt !== null
          ? h('div', { className: 'mb-card-sub', key: 'at' }, t('next.every', { time: formatDateTime(nextRunAt), interval: intervalLabel(schedule.intervalMinutes || 60, t) }))
          : h('div', { className: 'mb-card-sub', key: 'hint' }, t('next.hint')),
        h(
          'div',
          { className: `mb-hint mb-hint-watch${schedule?.watch ? ' is-on' : ''}`, key: 'watch' },
          schedule?.watch ? t('next.watchOn', { n: schedule.debounceSeconds || 60 }) : t('next.watchOff'),
        ),
      ];
      return h(Card, {
        title: t('card.nextBackup'),
        icon: h(IconClock),
        action: h(Btn, { variant: 'ghost', size: 'sm', onClick: () => onOpen('settings') }, t('next.open')),
        children,
      });
    }

    /** Banner model from `restore.pending` (in-flight marker) or `restore.last` awaiting ack after a restart. */
    function buildRestoreNotice(t, overview) {
      const restore = overview?.restore || {};
      const pending = restore.pending || null;
      if (pending) {
        const applying = pending.phase === 'applying';
        return {
          tone: applying ? 'warn' : 'info',
          title: applying ? t('banner.pendingApplying') : t('banner.pendingApplied'),
          body: applying
            ? t('banner.pendingApplyingBody', { name: pending.snapshotName || '—' })
            : t('banner.pendingAppliedBody', {
                name: pending.snapshotName || '—',
                time: pending.finishedAt ? formatDateTime(pending.finishedAt) : formatDateTime(pending.startedAt) || '—',
              }),
          targets: Array.isArray(pending.targets) ? pending.targets.map((item) => item?.target).filter(Boolean) : [],
          safetyPath: pending.safetyPath || null,
        };
      }
      const last = restore.last || null;
      if (!last || last.pendingAck !== true) return null;
      const targets = Array.isArray(last.targets) ? last.targets.map((item) => item?.target).filter(Boolean) : [];
      if (last.rolledBack) {
        return {
          tone: 'info',
          title: t('banner.lastRolledBack'),
          body: t('banner.lastRolledBackBody', { time: last.rolledBackAt ? formatDateTime(last.rolledBackAt) : '—' }),
          targets,
          safetyPath: last.safetyPath || null,
        };
      }
      if (last.interrupted) {
        return {
          tone: 'warn',
          title: t('banner.lastInterrupted'),
          body: last.message || t('banner.lastInterruptedBody'),
          targets,
          safetyPath: last.safetyPath || null,
        };
      }
      return {
        tone: 'info',
        title: t('banner.lastApplied'),
        body: t('banner.lastAppliedBody', {
          name: last.snapshotName || '—',
          time: last.appliedAt ? formatDateTime(last.appliedAt) : '—',
        }),
        targets,
        safetyPath: last.safetyPath || null,
      };
    }

    function RestoreNoticeBanner({ t, notice, onClear, clearing, error }) {
      if (!notice) return null;
      const warn = notice.tone === 'warn';
      return h(
        'div',
        { className: `mb-banner${warn ? ' is-warn' : ' is-info'}`, role: 'status' },
        h('span', { className: 'mb-banner-icon' }, warn ? h(IconAlert, { size: 14 }) : h(IconCheck, { size: 14 })),
        h(
          'div',
          { className: 'mb-banner-main' },
          h('div', { className: 'mb-banner-title' }, notice.title),
          h('div', { className: 'mb-banner-body' }, notice.body),
          notice.targets.length > 0
            ? h('div', { className: 'mb-banner-body mb-banner-targets' }, t('banner.pendingTargets', { targets: notice.targets.join(' · ') }))
            : null,
          error ? h('div', { className: 'mb-banner-error' }, error) : null,
        ),
        h(
          'div',
          { className: 'mb-banner-actions' },
          notice.safetyPath ? h('span', { className: 'mb-banner-path mb-ellipsis', title: notice.safetyPath }, notice.safetyPath) : null,
          h(Btn, { size: 'sm', busy: clearing, onClick: onClear }, clearing ? t('action.saving') : t('banner.pendingClear')),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Overview tab
    // ---------------------------------------------------------------------------------------

    function OverviewTab({ t, overview, onOpenTab }) {
      const schedule = overview?.schedule || null;
      const busyKind = busyKindOf(overview);
      const warnings = Array.isArray(overview?.warnings) ? overview.warnings : [];
      const last = readLastBackup(overview?.backup?.last);
      const now = useNow(30_000);
      const counts = overview?.counts || {};

      const summary = [
        {
          key: 'connection',
          title: t('ov.connectionRow'),
          value: t(`conn.state.${['connected', 'unauthorized', 'error'].includes(overview?.connection?.state) ? overview.connection.state : 'unknown'}`),
          hint: overview?.connection?.nickname || '',
          onClick: () => onOpenTab('overview'),
        },
        {
          key: 'last',
          title: t('ov.lastRow'),
          value: last?.at ? formatDateTime(last.at) : t('last.never'),
          hint: last ? `${t(`result.${resultKey(last.result)}`)} · ${last.at ? formatRelative(last.at, now, t) : ''}` : t('last.neverHint'),
          onClick: () => onOpenTab('snapshots'),
        },
        {
          key: 'schedule',
          title: t('ov.scheduleRow'),
          value: schedule?.enabled ? intervalLabel(schedule.intervalMinutes || 60, t) : t('next.off'),
          hint: schedule?.enabled
            ? schedule.watch
              ? t('ov.watchOn', { n: schedule.debounceSeconds || 60 })
              : t('ov.watchOff')
            : t('ov.scheduleOff'),
          onClick: () => onOpenTab('settings'),
        },
      ];

      const healthy = warnings.length === 0;
      return h(
        'div',
        { className: 'mb-ov' },
        busyKind ? h('div', { className: 'mb-note mb-ov-lock' }, h(Spinner, { size: 11 }), ' ', t('ov.lock', { kind: t(`lock.${busyKind}`) })) : null,
        h(
          'section',
          { className: `mb-health${healthy ? ' is-ok' : ' is-warn'}` },
          h('span', { className: 'mb-health-icon' }, healthy ? h(IconCheck, { size: 16 }) : h(IconAlert, { size: 16 })),
          h(
            'div',
            { className: 'mb-health-main' },
            h('div', { className: 'mb-health-title' }, healthy ? t('ov.healthy') : t('ov.attention', { n: warnings.length })),
            healthy
              ? h('div', { className: 'mb-health-body' }, t('ov.healthyBody'))
              : h(
                  'ul',
                  { className: 'mb-list mb-list-warn mb-health-list' },
                  warnings.map((warning, index) => h('li', { key: `w${index}` }, h('span', { className: 'mb-list-text' }, warning))),
                ),
          ),
          h(
            'div',
            { className: 'mb-health-facts' },
            h(
              'button',
              { type: 'button', className: 'mb-fact', onClick: () => onOpenTab('settings') },
              h('span', { className: 'mb-fact-label' }, t('ov.policy')),
              h('span', { className: 'mb-fact-value' }, summary[2].value),
            ),
            h(
              'button',
              { type: 'button', className: 'mb-fact', onClick: () => onOpenTab('scope') },
              h('span', { className: 'mb-fact-label' }, t('ov.scopeRow')),
              h(
                'span',
                { className: 'mb-fact-value' },
                typeof counts.scopeFiles === 'number'
                  ? t('ov.scopeLine', { files: formatInt(counts.scopeFiles), bytes: formatBytes(counts.scopeBytes) })
                  : t('ov.scopeUnknown'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'mb-ov-grid' },
          h(
            Section,
            { title: t('ov.protected'), meta: String(PROTECTED.length), className: 'mb-fill' },
            h('div', { className: 'mb-hint' }, t('ov.protectedIntro')),
            h(
              'div',
              { className: 'mb-protect-grid mb-fill-body' },
              PROTECTED.map((item) =>
                h(
                  'div',
                  { key: item.path, className: 'mb-protect' },
                  h('code', { className: 'mb-protect-path' }, item.path),
                  h('span', { className: 'mb-protect-desc' }, t(item.key)),
                ),
              ),
            ),
          ),
          h(
            Section,
            { title: t('ov.tips'), className: 'mb-fill' },
            h(
              'ol',
              { className: 'mb-tips mb-fill-body' },
              TIPS.map((item) =>
                h(
                  'li',
                  { key: item.key },
                  h('span', { className: 'mb-list-text' }, t(item.key)),
                  item.commandKey ? h('code', { className: 'mb-code' }, t(item.commandKey)) : null,
                ),
              ),
            ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Scope tab
    // ---------------------------------------------------------------------------------------

    function applyToggle(scope, src, enabled) {
      if (!scope || !Array.isArray(scope.entries)) return scope;
      const entries = scope.entries.map((entry) => (entry.src === src ? { ...entry, disabled: !enabled } : entry));
      const enabledEntries = entries.filter((entry) => !entry.disabled).length;
      return { ...scope, entries, totals: { ...(scope.totals || {}), enabledEntries } };
    }

    function ScopeTab({ t, reloadKey, busyKind }) {
      const [scope, setScope] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [pendingSrc, setPendingSrc] = useState(null);
      const [toggleError, setToggleError] = useState(null);
      const mountedRef = useRef(true);
      const inFlightRef = useRef(false);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const load = useCallback(async (refresh) => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        if (refresh) setRefreshing(true);
        setError(null);
        try {
          const payload = await api.scope(refresh);
          if (!mountedRef.current) return;
          setScope(payload.scope || null);
        } catch (caught) {
          if (mountedRef.current) setError(messageOf(caught));
        } finally {
          inFlightRef.current = false;
          if (mountedRef.current) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }, []);

      useEffect(() => {
        load(false);
      }, [load, reloadKey]);

      const toggle = async (entry) => {
        const enabled = Boolean(entry.disabled);
        if (pendingSrc) return;
        setPendingSrc(entry.src);
        setToggleError(null);
        setScope((previous) => applyToggle(previous, entry.src, enabled));
        try {
          const payload = await api.toggleScope(entry.src, enabled);
          if (!mountedRef.current) return;
          if (payload.scope) setScope(payload.scope);
        } catch (caught) {
          if (!mountedRef.current) return;
          setScope((previous) => applyToggle(previous, entry.src, !enabled));
          setToggleError(messageOf(caught) || t('scope.toggleFailed'));
        } finally {
          if (mountedRef.current) setPendingSrc(null);
        }
      };

      const entries = scope?.entries || [];
      const unreadable = entries.filter((entry) => !entry.readable || !entry.exists);
      const totals = totalOf(scope);
      const excluded = Array.isArray(scope?.excluded) ? scope.excluded : [];
      const notes = Array.isArray(scope?.notes) ? scope.notes : [];

      const header = h(
        'div',
        { className: 'mb-section-lead' },
        h('div', { className: 'mb-section-lead-text' }, h('div', { className: 'mb-section-title' }, t('scope.title')), h('div', { className: 'mb-hint' }, t('scope.subtitle'))),
        h(Btn, { size: 'sm', busy: refreshing, onClick: () => load(true) }, refreshing ? t('scope.loading') : t('scope.refresh')),
      );

      if (loading && !scope) return h('div', { className: 'mb-stack' }, header, h(LoadingState, { t, label: t('scope.loading') }));

      if (error && !scope) {
        return h(
          'div',
          { className: 'mb-stack' },
          header,
          h(InlineError, { message: error, onRetry: () => load(true), retryLabel: t('action.retry') }),
          h(EmptyState, { t, title: t('scope.error'), body: t('scope.emptyBody') }),
        );
      }

      return h(
        'div',
        { className: 'mb-tabfill' },
        header,
        busyKind ? h('div', { className: 'mb-hint' }, t('scope.busyHint')) : null,
        error ? h(InlineError, { message: error, onRetry: () => load(true), retryLabel: t('action.retry') }) : null,
        toggleError ? h(InlineError, { message: toggleError, onDismiss: () => setToggleError(null) }) : null,
        entries.length === 0
          ? h(EmptyState, { t, title: t('scope.empty'), body: t('scope.emptyBody') })
          : h(
              'div',
              { className: 'mb-tablewrap mb-scroll' },
              h(
                'table',
                { className: 'mb-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'mb-th' }, t('scope.col.name')),
                    h('th', { className: 'mb-th' }, t('scope.col.local')),
                    h('th', { className: 'mb-th' }, t('scope.col.dest')),
                    h('th', { className: 'mb-th mb-num' }, t('scope.col.files')),
                    h('th', { className: 'mb-th mb-num' }, t('scope.col.bytes')),
                    h('th', { className: 'mb-th' }, t('scope.col.readable')),
                    h('th', { className: 'mb-th mb-col-toggle' }, t('scope.col.enabled')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  entries.map((entry) => {
                    const broken = !entry.readable || !entry.exists;
                    return h(
                      'tr',
                      { key: entry.src, className: `mb-tr${entry.disabled ? ' is-off' : ''}${broken ? ' is-warn' : ''}` },
                      h(
                        'td',
                        { className: 'mb-td' },
                        h(
                          'div',
                          { className: 'mb-cell-name' },
                          h('span', { className: 'mb-ellipsis', title: entry.label || entry.dest }, entry.label || entry.dest),
                          entry.discovered ? h(Chip, { tone: 'brand', title: t('scope.col.discovered') }, t('scope.discovered')) : null,
                        ),
                        entry.warning ? h('div', { className: 'mb-cell-warn' }, h(IconAlert, { size: 11 }), h('span', null, entry.warning)) : null,
                      ),
                      h('td', { className: 'mb-td mb-pathcell' }, h('code', { className: 'mb-code', title: entry.src }, entry.src)),
                      h('td', { className: 'mb-td mb-pathcell' }, h('code', { className: 'mb-code', title: entry.dest }, entry.dest)),
                      h('td', { className: 'mb-td mb-num' }, formatInt(entry.files)),
                      h('td', { className: 'mb-td mb-num' }, formatBytes(entry.bytes)),
                      h(
                        'td',
                        { className: 'mb-td' },
                        h(
                          'span',
                          { className: 'mb-readcell' },
                          h(Dot, { tone: broken ? 'error' : 'success' }),
                          h('span', null, t(broken ? (entry.exists ? 'scope.unreadable' : 'scope.missing') : 'scope.readable')),
                        ),
                      ),
                      h(
                        'td',
                        { className: 'mb-td mb-col-toggle' },
                        h(Switch, {
                          checked: !entry.disabled,
                          disabled: Boolean(busyKind) || pendingSrc === entry.src,
                          label: `${t('scope.col.enabled')}: ${entry.label || entry.dest}`,
                          onChange: () => toggle(entry),
                        }),
                      ),
                    );
                  }),
                ),
              ),
            ),
        h(
          'div',
          { className: 'mb-scope-foot' },
          h(ExcludedList, { t, excluded }),
          notes.length > 0 ? h(Collapsible, { title: t('scope.notes'), meta: String(notes.length), children: h('ul', { className: 'mb-list' }, notes.map((note, index) => h('li', { key: `n${index}` }, h('span', { className: 'mb-list-text' }, note)))) }) : null,
        ),
        h(
          'div',
          { className: 'mb-totals' },
          totals
            ? t('scope.totals', {
                enabled:
                  typeof scope?.totals?.enabledEntries === 'number'
                    ? scope.totals.enabledEntries
                    : entries.filter((entry) => !entry.disabled).length,
                total: entries.length,
                files: formatInt(totals.files),
                bytes: formatBytes(totals.bytes),
              })
            : null,
          unreadable.length > 0 ? h(Chip, { tone: 'error' }, t('scope.unreadableCount', { n: unreadable.length })) : null,
        ),
      );
    }

    function ExcludedList({ t, excluded }) {
      if (!excluded || excluded.length === 0) return null;
      return h(Collapsible, {
        title: t('scope.excluded', { n: excluded.length }),
        children: h(
          'ul',
          { className: 'mb-list mb-list-excluded' },
          excluded.map((item, index) =>
            h('li', { key: `${item.path}-${index}` }, h('code', { className: 'mb-code' }, item.path), h('span', { className: 'mb-list-text' }, item.reason || '')),
          ),
        ),
      });
    }

    // ---------------------------------------------------------------------------------------
    // Snapshot diff
    // ---------------------------------------------------------------------------------------

    const DIFF_GROUPS = [
      { key: 'added', labelKey: 'snapTab.diffAdded', tone: 'added' },
      { key: 'overwritten', labelKey: 'snapTab.diffOverwritten', tone: 'overwritten' },
      { key: 'deleted', labelKey: 'snapTab.diffDeleted', tone: 'deleted' },
    ];

    function DiffGroup({ t, title, tone, items, count }) {
      const [open, setOpen] = useState(tone === 'added');
      const list = Array.isArray(items) ? items : [];
      const total = typeof count === 'number' ? count : list.length;
      return h(
        'div',
        { className: `mb-diff-group is-${tone}` },
        h(
          'button',
          { type: 'button', className: 'mb-diff-group-head', onClick: () => setOpen((value) => !value), 'aria-expanded': open },
          h(IconChevron, { open }),
          h('span', { className: 'mb-diff-group-title' }, title),
          h('span', { className: 'mb-diff-group-count' }, formatInt(total)),
        ),
        open
          ? list.length === 0
            ? h('div', { className: 'mb-hint mb-diff-group-body' }, t('snapTab.noDiff'))
            : h(
                'ul',
                { className: 'mb-diff-items' },
                list.slice(0, SAMPLE_LIMIT).map((item, index) => h('li', { key: index }, h('code', { className: 'mb-code' }, item))),
              )
          : null,
        open && total > list.length ? h('div', { className: 'mb-hint mb-diff-group-body' }, t('snapTab.samplesLimit', { n: SAMPLE_LIMIT })) : null,
      );
    }

    function DiffPanel({ t, diff }) {
      const counts = diff?.counts || {};
      const bytes = diff?.bytes || {};
      const targets = Array.isArray(diff?.targets) ? diff.targets : [];
      const protectedPaths = Array.isArray(diff?.protected) ? diff.protected : [];
      const warnings = Array.isArray(diff?.warnings) ? diff.warnings : [];
      const samples = diff?.samples || {};
      return h(
        'div',
        { className: 'mb-diff' },
        h('div', { className: 'mb-diff-title' }, t('snapTab.diff')),
        h(
          'div',
          { className: 'mb-diff-stats' },
          DIFF_GROUPS.map((group) =>
            h(
              'div',
              { className: `mb-diff-stat is-${group.tone}`, key: group.key },
              h('span', { className: 'mb-diff-stat-value' }, formatInt(counts[group.key] || 0)),
              h('span', { className: 'mb-diff-stat-label' }, t(group.labelKey)),
            ),
          ),
          h(
            'div',
            { className: 'mb-diff-stat is-neutral' },
            h('span', { className: 'mb-diff-stat-value' }, formatInt(counts.unchanged || 0)),
            h('span', { className: 'mb-diff-stat-label' }, t('snapTab.diffUnchanged')),
          ),
        ),
        h('div', { className: 'mb-hint mb-diff-bytes' }, t('snapTab.diffBytes', {
          added: formatBytes(bytes.added || 0),
          overwritten: formatBytes(bytes.overwritten || 0),
          deleted: formatBytes(bytes.deleted || 0),
        })),
        h(
          'div',
          { className: 'mb-diff-groups' },
          DIFF_GROUPS.map((group) =>
            h(DiffGroup, { key: group.key, t, title: t(group.labelKey), tone: group.tone, items: samples[group.key], count: counts[group.key] }),
          ),
        ),
        targets.length > 0
          ? h(
              'div',
              { className: 'mb-diff-block' },
              h('div', { className: 'mb-diff-block-title' }, t('snapTab.diffTargets')),
              targets.map((target, index) =>
                h(
                  'div',
                  { className: 'mb-diff-target', key: index },
                  h('code', { className: 'mb-code' }, target.prefix || ''),
                  h('span', { className: 'mb-diff-arrow' }, '→'),
                  h('code', { className: 'mb-code' }, target.target || ''),
                ),
              ),
            )
          : null,
        protectedPaths.length > 0
          ? h(
              'div',
              { className: 'mb-diff-block' },
              h('div', { className: 'mb-diff-block-title' }, t('snapTab.diffProtected')),
              protectedPaths.map((item, index) =>
                h('div', { className: 'mb-diff-target', key: index }, h('code', { className: 'mb-code' }, item.path), h('span', { className: 'mb-hint' }, item.reason || '')),
              ),
            )
          : null,
        warnings.length > 0
          ? h(
              'div',
              { className: 'mb-diff-block' },
              h('div', { className: 'mb-diff-block-title' }, t('snapTab.diffWarnings')),
              h('ul', { className: 'mb-list mb-list-warn' }, warnings.map((warning, index) => h('li', { key: index }, h(IconAlert, { size: 12 }), h('span', { className: 'mb-list-text' }, warning)))),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Snapshots & restore tab
    // ---------------------------------------------------------------------------------------

    const SCOPE_HINT_KEY = { all: 'snapTab.scopeAllHint', config: 'snapTab.scopeConfigHint', workspace: 'snapTab.scopeWorkspaceHint' };
    const SCOPE_LABEL_KEY = { all: 'snapTab.scopeAll', config: 'snapTab.scopeConfig', workspace: 'snapTab.scopeWorkspace' };

    function SnapshotsTab({ t, overview, reloadKey, busyKind, onArchiveCount, onRefreshOverview }) {
      const mountedRef = useRef(true);
      const [snapshots, setSnapshots] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [selectedName, setSelectedName] = useState(null);
      const [preview, setPreview] = useState(null);
      const [previewLoading, setPreviewLoading] = useState(false);
      const [previewError, setPreviewError] = useState(null);
      const [scope, setScope] = useState('all');
      const [includeSelf, setIncludeSelf] = useState(false);
      const [staging, setStaging] = useState(null);
      const [stagedKey, setStagedKey] = useState(null);
      const [stagingLoading, setStagingLoading] = useState(false);
      const [stagingStartedAt, setStagingStartedAt] = useState(null);
      const [stagingError, setStagingError] = useState(null);
      const [discardBusy, setDiscardBusy] = useState(false);
      const [confirmOpen, setConfirmOpen] = useState(false);
      const [confirmError, setConfirmError] = useState(null);
      const [applyLoading, setApplyLoading] = useState(false);
      const [applyResult, setApplyResult] = useState(null);
      const [applyError, setApplyError] = useState(null);
      const [rollbackOpen, setRollbackOpen] = useState(false);
      const [rollbackBusy, setRollbackBusy] = useState(false);
      const [rollbackError, setRollbackError] = useState(null);
      const [rollbackDone, setRollbackDone] = useState(false);
      const now = useNow(stagingLoading ? 1000 : 5000);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      const loadSnapshots = useCallback(
        async (refresh) => {
          if (refresh) setRefreshing(true);
          else setLoading(true);
          setError(null);
          try {
            const payload = await api.snapshots(refresh);
            if (!mountedRef.current) return;
            setSnapshots(Array.isArray(payload.snapshots) ? payload.snapshots : []);
            if (onArchiveCount) onArchiveCount(typeof payload.archiveCount === 'number' ? payload.archiveCount : null);
          } catch (caught) {
            if (mountedRef.current) setError(messageOf(caught));
          } finally {
            if (mountedRef.current) {
              setLoading(false);
              setRefreshing(false);
            }
          }
        },
        [onArchiveCount],
      );

      useEffect(() => {
        loadSnapshots(true);
      }, [loadSnapshots, reloadKey]);

      const selected = Array.isArray(snapshots) ? snapshots.find((snapshot) => snapshot.name === selectedName) || null : null;
      const currentKey = `${selectedName}|${scope}|${includeSelf}`;
      const stagingFresh = Boolean(staging) && stagedKey === currentKey;
      const stagingStale = Boolean(staging) && stagedKey !== currentKey;

      const selectSnapshot = (name) => {
        if (name === selectedName) return;
        setSelectedName(name);
        setPreview(null);
        setPreviewError(null);
        setStaging(null);
        setStagedKey(null);
        setStagingError(null);
        setApplyResult(null);
        setApplyError(null);
        setRollbackDone(false);
        setScope('all');
        setIncludeSelf(false);
      };

      const loadPreview = async () => {
        if (!selected || previewLoading) return;
        setPreviewLoading(true);
        setPreviewError(null);
        try {
          const payload = await api.previewSnapshot(selected.name);
          if (mountedRef.current) setPreview({ name: selected.name, data: payload.preview || null });
        } catch (caught) {
          if (mountedRef.current) setPreviewError(messageOf(caught));
        } finally {
          if (mountedRef.current) setPreviewLoading(false);
        }
      };

      const runStage = async () => {
        if (!selected || stagingLoading || busyKind) return;
        setStagingLoading(true);
        setStagingStartedAt(Date.now());
        setStagingError(null);
        setStaging(null);
        setStagedKey(null);
        setApplyResult(null);
        setApplyError(null);
        try {
          const payload = await api.stageRestore(selected.name, scope, includeSelf);
          if (!mountedRef.current) return;
          setStaging(payload.staging || null);
          setStagedKey(`${selected.name}|${scope}|${includeSelf}`);
        } catch (caught) {
          if (mountedRef.current) setStagingError(messageOf(caught));
        } finally {
          if (mountedRef.current) {
            setStagingLoading(false);
            setStagingStartedAt(null);
          }
        }
      };

      const doApply = async () => {
        if (!staging || applyLoading) return;
        setApplyLoading(true);
        setConfirmError(null);
        setApplyError(null);
        try {
          const payload = await api.applyRestore(staging.stagingId, scope, includeSelf);
          if (!mountedRef.current) return;
          setApplyResult(payload.result || {});
          setConfirmOpen(false);
          setStaging(null);
          setStagedKey(null);
          setRollbackDone(false);
          if (onRefreshOverview) onRefreshOverview();
        } catch (caught) {
          if (mountedRef.current) {
            const message = messageOf(caught);
            setConfirmError(message);
            setApplyError(message);
          }
        } finally {
          if (mountedRef.current) setApplyLoading(false);
        }
      };

      const discard = async () => {
        if (!staging || discardBusy) return;
        setDiscardBusy(true);
        try {
          await api.discardRestore(staging.stagingId);
          if (!mountedRef.current) return;
          setStaging(null);
          setStagedKey(null);
        } catch (caught) {
          if (mountedRef.current) setStagingError(messageOf(caught));
        } finally {
          if (mountedRef.current) setDiscardBusy(false);
        }
      };

      const doRollback = async () => {
        if (rollbackBusy) return;
        setRollbackBusy(true);
        setRollbackError(null);
        try {
          await api.rollback();
          if (!mountedRef.current) return;
          setRollbackOpen(false);
          setRollbackDone(true);
          setApplyResult(null);
          if (onRefreshOverview) onRefreshOverview();
        } catch (caught) {
          if (mountedRef.current) setRollbackError(messageOf(caught));
        } finally {
          if (mountedRef.current) setRollbackBusy(false);
        }
      };

      const safetyPath =
        (applyResult && (applyResult.safetyPath || applyResult.safety?.path)) || overview?.restore?.pending?.safetyPath || null;
      const pendingTargets = Array.isArray(overview?.restore?.pending?.targets) ? overview.restore.pending.targets : [];
      const diffTargets = Array.isArray(staging?.diff?.targets) ? staging.diff.targets : [];

      const renderManifest = () => {
        if (previewLoading) return h('div', { className: 'mb-hint' }, h(Spinner, { size: 11 }), ' ', t('snapTab.previewLoading'));
        if (previewError) return h(InlineError, { message: previewError || t('snapTab.previewError'), onRetry: loadPreview, retryLabel: t('action.retry') });
        if (!preview || preview.name !== selectedName) return null;
        const data = preview.data || {};
        const manifest = data.manifest || null;
        if (!data.available || !manifest) return h('div', { className: 'mb-hint' }, data.message || t('snapTab.previewMissing'));
        const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        return h(
          'div',
          { className: 'mb-manifest' },
          h(
            'div',
            { className: 'mb-manifest-head' },
            h('span', { className: 'mb-manifest-title' }, t('snapTab.manifest')),
            h(Chip, { tone: 'brand' }, t('snapTab.manifestSource', { source: data.source || 'none' })),
            manifest.partial ? h(Chip, { tone: 'error' }, t('snapTab.manifestPartial')) : null,
          ),
          h(
            'div',
            { className: 'mb-manifest-stats' },
            typeof manifest.file_count === 'number'
              ? h('span', null, t('snapTab.manifestFiles', { n: formatInt(manifest.file_count) }))
              : files.length > 0
                ? h('span', null, t('snapTab.manifestFiles', { n: formatInt(files.length) }))
                : null,
            typeof manifest.approx_size_mb === 'number'
              ? h('span', null, t('snapTab.manifestSize', { size: formatBytes(manifest.approx_size_mb * 1024 * 1024) }))
              : null,
            manifest.hostname ? h('span', { className: 'mb-ellipsis' }, manifest.hostname) : null,
            manifest.created_at ? h('span', null, String(manifest.created_at)) : null,
          ),
          entries.length > 0
            ? h(
                'div',
                { className: 'mb-manifest-entries' },
                h('div', { className: 'mb-manifest-sub' }, t('snapTab.manifestEntries')),
                entries.length > 12 ? h('div', { className: 'mb-hint' }, t('snapTab.manifestTruncated', { n: entries.length, shown: 12 })) : null,
                entries.slice(0, 12).map((entry, index) =>
                  h(
                    'div',
                    { className: 'mb-manifest-entry', key: index },
                    h('code', { className: 'mb-code' }, entry.dest || ''),
                    h('span', { className: 'mb-manifest-entry-meta' }, t('snapTab.manifestEntry', { files: formatInt(entry.files), bytes: formatBytes(entry.bytes) })),
                  ),
                ),
              )
            : null,
        );
      };

      const scopeOptions = RESTORE_SCOPES.map((value) => ({ value, label: t(SCOPE_LABEL_KEY[value]), hint: t(SCOPE_HINT_KEY[value]) }));

      const header = h(
        'div',
        { className: 'mb-section-lead' },
        h(
          'div',
          { className: 'mb-section-lead-text' },
          h('div', { className: 'mb-section-title' }, t('snapTab.title')),
          h('div', { className: 'mb-hint' }, t('snapTab.subtitle')),
        ),
        h(Btn, { size: 'sm', busy: refreshing, onClick: () => loadSnapshots(true) }, refreshing ? t('snapTab.loading') : t('snapTab.refresh')),
      );

      const applyWarnings = Array.isArray(applyResult?.warnings) ? applyResult.warnings : [];
      const appliedList = Array.isArray(applyResult?.applied) ? applyResult.applied : [];
      const appliedFiles = appliedList.reduce((sum, item) => sum + (Number(item?.files) || 0), 0);
      const appliedBytes = appliedList.reduce((sum, item) => sum + (Number(item?.bytes) || 0), 0);

      const appliedCard = applyResult
        ? h(
            'div',
            { className: 'mb-applied' },
            h(
              'div',
              { className: 'mb-applied-head' },
              h('span', { className: 'mb-applied-icon' }, h(IconCheck, { size: 14 })),
              h('div', null, h('div', { className: 'mb-applied-title' }, t('snapTab.appliedTitle')), h('div', { className: 'mb-hint' }, t('snapTab.appliedBody'))),
            ),
            h('div', { className: 'mb-hint' }, t('snapTab.appliedManual')),
            appliedList.length > 0
              ? h('div', { className: 'mb-hint' }, t('snapTab.appliedTotals', { files: formatInt(appliedFiles), bytes: formatBytes(appliedBytes) }))
              : null,
            applyResult?.selfSkipped ? h('div', { className: 'mb-hint' }, t('snapTab.selfSkipped')) : null,
            applyWarnings.length > 0
              ? h(
                  'ul',
                  { className: 'mb-list mb-list-warn' },
                  applyWarnings.map((warning, index) => h('li', { key: `aw${index}` }, h(IconAlert, { size: 12 }), h('span', { className: 'mb-list-text' }, warning))),
                )
              : null,
            h(
              'div',
              { className: 'mb-applied-path' },
              h('span', { className: 'mb-applied-path-label' }, t('snapTab.safetyPath')),
              safetyPath ? h('code', { className: 'mb-code' }, safetyPath) : h('span', { className: 'mb-hint' }, t('snapTab.safetyNone')),
            ),
            rollbackDone ? h('div', { className: 'mb-note' }, h(IconCheck, { size: 12 }), ' ', t('snapTab.rollbackDone')) : null,
            rollbackError ? h(InlineError, { message: rollbackError || t('snapTab.rollbackFailed') }) : null,
            h(
              'div',
              { className: 'mb-actions' },
              h(Btn, { variant: 'danger', onClick: () => setRollbackOpen(true), disabled: rollbackDone }, t('snapTab.rollback')),
            ),
          )
        : null;

      const detail = selected
        ? h(
            'div',
            { className: 'mb-detail' },
            h(
              'div',
              { className: 'mb-detail-head' },
              h('div', { className: 'mb-detail-title' }, h(IconLayers), h('code', { className: 'mb-code' }, selected.name)),
              h(Btn, { size: 'sm', busy: previewLoading, onClick: loadPreview }, previewLoading ? t('snapTab.previewLoading') : t('snapTab.preview')),
            ),
            !selected.sidecarFid ? h('div', { className: 'mb-hint mb-hint-warn' }, t('snapTab.oldSnapshot')) : null,
            renderManifest(),
            h('div', { className: 'mb-divider' }),
            h('div', { className: 'mb-subtitle' }, t('snapTab.restoreScope')),
            h(RadioGroup, {
              label: t('snapTab.restoreScope'),
              value: scope,
              disabled: stagingLoading || Boolean(busyKind),
              options: scopeOptions,
              onChange: (next) => {
                setScope(next);
                setApplyError(null);
              },
            }),
            h(
              'div',
              { className: 'mb-switchrow' },
              h(
                'div',
                { className: 'mb-switchrow-text' },
                h('div', { className: 'mb-switchrow-label' }, t('snapTab.includeSelf')),
                h('div', { className: 'mb-hint' }, t('snapTab.includeSelfHint')),
              ),
              h(Switch, {
                checked: includeSelf,
                disabled: stagingLoading || Boolean(busyKind),
                label: t('snapTab.includeSelf'),
                onChange: (next) => {
                  setIncludeSelf(next);
                  setApplyError(null);
                },
              }),
            ),
            includeSelf ? h('div', { className: 'mb-danger-box' }, h(IconAlert, { size: 13 }), h('span', null, t('snapTab.includeSelfWarn'))) : null,
            busyKind ? h('div', { className: 'mb-hint mb-hint-warn' }, t(busyKind === 'backup' ? 'snapTab.busyBackup' : 'snapTab.busyRestore')) : null,
            stagingStale ? h('div', { className: 'mb-hint mb-hint-warn' }, t('snapTab.staleDiff')) : null,
            h(
              'div',
              { className: 'mb-actions' },
              h(
                Btn,
                { variant: 'primary', busy: stagingLoading, disabled: Boolean(busyKind) || stagingLoading, onClick: runStage },
                stagingLoading ? t('snapTab.staging') : t('snapTab.stage'),
              ),
              staging && !stagingLoading
                ? h(Btn, { busy: discardBusy, onClick: discard }, discardBusy ? t('action.saving') : t('snapTab.discard'))
                : null,
            ),
            stagingLoading
              ? h(
                  'div',
                  { className: 'mb-loading-box' },
                  h(Spinner, { size: 13 }),
                  h(
                    'div',
                    { className: 'mb-loading-text' },
                    h('div', null, t('snapTab.staging')),
                    h('div', { className: 'mb-hint' }, t('snapTab.stagingHint')),
                    stagingStartedAt
                      ? h('div', { className: 'mb-hint' }, t('snapTab.stagingElapsed', { time: formatDuration(Math.max(0, now - stagingStartedAt), t) }))
                      : null,
                  ),
                )
              : null,
            stagingError ? h(InlineError, { message: stagingError || t('snapTab.stageError'), onRetry: runStage, retryLabel: t('action.retry') }) : null,
            stagingFresh && staging?.diff ? h(DiffPanel, { t, diff: staging.diff }) : null,
            applyError ? h(InlineError, { message: applyError }) : null,
            stagingFresh
              ? h(
                  'div',
                  { className: 'mb-actions mb-actions-end' },
                  h(
                    Btn,
                    {
                      variant: 'danger',
                      disabled: Boolean(busyKind),
                      onClick: () => {
                        setConfirmError(null);
                        setConfirmOpen(true);
                      },
                    },
                    t('snapTab.apply'),
                  ),
                )
              : null,
          )
        : h(
            'div',
            { className: 'mb-detail mb-detail-empty' },
            h('span', { className: 'mb-state-icon' }, h(IconLayers)),
            h('span', null, t('snapTab.noSelection')),
          );

      const table =
        Array.isArray(snapshots) && snapshots.length > 0
          ? h(
              'div',
              { className: 'mb-tablewrap mb-scroll' },
              h(
                'table',
                { className: 'mb-table mb-table-snap' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'mb-th' }, t('snapTab.col.name')),
                    h('th', { className: 'mb-th mb-num' }, t('snapTab.col.size')),
                    h('th', { className: 'mb-th' }, t('snapTab.col.state')),
                    h('th', { className: 'mb-th' }, t('snapTab.col.sidecar')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  snapshots.map((snapshot) => {
                    const complete = typeof snapshot.createdAt === 'number' && Number(snapshot.size) > 0;
                    const active = snapshot.name === selectedName;
                    const choose = () => selectSnapshot(snapshot.name);
                    return h(
                      'tr',
                      {
                        key: snapshot.name,
                        className: `mb-tr is-clickable${active ? ' is-active' : ''}`,
                        tabIndex: 0,
                        onClick: choose,
                        onKeyDown: (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose();
                          }
                        },
                      },
                      h(
                        'td',
                        { className: 'mb-td' },
                        h(
                          'div',
                          { className: 'mb-snapcell' },
                          h('span', { className: 'mb-snapcell-date' }, snapshot.createdAt ? formatDateTime(snapshot.createdAt) : '—'),
                          h('span', { className: 'mb-snapcell-name', title: snapshot.name }, snapshot.name),
                        ),
                      ),
                      h('td', { className: 'mb-td mb-num' }, formatBytes(snapshot.size)),
                      h('td', { className: 'mb-td' }, h(Chip, { tone: complete ? 'success' : 'warn' }, t(complete ? 'snapTab.complete' : 'snapTab.incomplete'))),
                      h('td', { className: 'mb-td' }, h(Chip, { tone: snapshot.sidecarFid ? 'brand' : 'neutral' }, t(snapshot.sidecarFid ? 'snapTab.sidecarYes' : 'snapTab.sidecarNo'))),
                    );
                  }),
                ),
              ),
            )
          : null;

      return h(
        'div',
        { className: 'mb-tabfill' },
        header,
        appliedCard,
        error ? h(InlineError, { message: error || t('snapTab.error'), onRetry: () => loadSnapshots(true), retryLabel: t('action.retry') }) : null,
        h(
          'div',
          { className: 'mb-split' },
          h(
            'div',
            { className: 'mb-split-list' },
            loading && !snapshots
              ? h(LoadingState, { t, label: t('snapTab.loading') })
              : Array.isArray(snapshots) && snapshots.length === 0
                ? h(EmptyState, { t, icon: h(IconLayers), title: t('snapTab.empty'), body: t('snapTab.emptyBody') })
                : table,
          ),
          h('div', { className: 'mb-split-detail' }, detail),
        ),
        confirmOpen && staging
          ? h(ConfirmDialog, {
              t,
              title: t('snapTab.confirmTitle'),
              body: t('snapTab.confirmBody', { name: staging.snapshotName || selectedName || '—', scope: t(SCOPE_LABEL_KEY[scope]) }),
              effects: h(
                'div',
                { className: 'mb-dialog-effects-list' },
                h('div', { className: 'mb-dialog-effects-title' }, t('snapTab.confirmEffects')),
                diffTargets.length > 0
                  ? diffTargets.map((item, index) => h('code', { className: 'mb-code', key: index }, item.target || item.prefix || ''))
                  : pendingTargets.map((item, index) => h('code', { className: 'mb-code', key: index }, item.target || '')),
              ),
              tone: 'danger',
              requireText: t('snapTab.confirmPlaceholder'),
              requireLabel: t('snapTab.confirmType'),
              confirmLabel: applyLoading ? t('snapTab.applying') : t('snapTab.apply'),
              busy: applyLoading,
              error: confirmError,
              onCancel: () => {
                if (!applyLoading) setConfirmOpen(false);
              },
              onConfirm: doApply,
            })
          : null,
        rollbackOpen
          ? h(ConfirmDialog, {
              t,
              title: t('snapTab.rollbackTitle'),
              body: t('snapTab.rollbackBody'),
              effects: safetyPath ? h('code', { className: 'mb-code' }, safetyPath) : null,
              tone: 'danger',
              checkboxLabel: t('snapTab.rollbackCheck'),
              confirmLabel: t('snapTab.rollback'),
              busy: rollbackBusy,
              error: rollbackError,
              onCancel: () => {
                if (!rollbackBusy) setRollbackOpen(false);
              },
              onConfirm: doRollback,
            })
          : null,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Settings tab
    // ---------------------------------------------------------------------------------------

    function scheduleForm(schedule) {
      return {
        enabled: Boolean(schedule.enabled),
        intervalMinutes: schedule.intervalMinutes || 60,
        keep: schedule.keep || 5,
        watch: Boolean(schedule.watch),
        debounceSeconds: schedule.debounceSeconds || 60,
      };
    }

    function sameScheduleForm(left, right) {
      return ['enabled', 'intervalMinutes', 'keep', 'watch', 'debounceSeconds'].every((key) => left[key] === right[key]);
    }

    function SettingsTab({ t, overview, reloadKey, onRefreshOverview }) {
      const schedule = overview?.schedule || null;
      const [form, setForm] = useState(null);
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState(null);
      const [saveNotice, setSaveNotice] = useState(null);
      const [restartOpen, setRestartOpen] = useState(false);
      const [restartBusy, setRestartBusy] = useState(false);
      const [restartError, setRestartError] = useState(null);
      const [restartDone, setRestartDone] = useState(false);
      const [restartInstructions, setRestartInstructions] = useState(null);
      const [logs, setLogs] = useState(null);
      const [logsLoading, setLogsLoading] = useState(true);
      const [logsError, setLogsError] = useState(null);
      const mountedRef = useRef(true);
      const logsRef = useRef(null);
      /** Values just saved; a poll that predates the save must not snap the form back. */
      const savedRef = useRef(null);

      useEffect(() => {
        mountedRef.current = true;
        return () => {
          mountedRef.current = false;
        };
      }, []);

      useEffect(() => {
        if (!schedule || dirty) return;
        const next = scheduleForm(schedule);
        const saved = savedRef.current;
        if (saved && Date.now() - saved.at < 30_000 && !sameScheduleForm(saved.form, next)) return;
        savedRef.current = null;
        setForm(next);
      }, [schedule, dirty]);

      useEffect(() => {
        const node = logsRef.current;
        if (node) node.scrollTop = node.scrollHeight;
      }, [logs]);

      const update = (patch) => {
        setForm((previous) => ({ ...(previous || {}), ...patch }));
        setDirty(true);
        setSaveNotice(null);
        setSaveError(null);
      };

      const save = async () => {
        if (!form || saving) return;
        setSaving(true);
        setSaveError(null);
        try {
          const payload = await api.saveSchedule(form);
          if (!mountedRef.current) return;
          const savedForm = payload.schedule ? scheduleForm(payload.schedule) : { ...form };
          savedRef.current = { form: savedForm, at: Date.now() };
          setForm(savedForm);
          setDirty(false);
          if (onRefreshOverview) onRefreshOverview();
          const persisted = payload.schedule?.persistedTo || null;
          setSaveNotice(persisted === 'local' ? 'local' : persisted === 'profile-patch' ? 'profile' : 'unknown');
        } catch (caught) {
          if (mountedRef.current) setSaveError(messageOf(caught));
        } finally {
          if (mountedRef.current) setSaving(false);
        }
      };

      const loadLogs = useCallback(async () => {
        setLogsLoading(true);
        setLogsError(null);
        try {
          const payload = await api.logs(LOG_LINES);
          if (mountedRef.current) setLogs(Array.isArray(payload.lines) ? payload.lines : []);
        } catch (caught) {
          if (mountedRef.current) setLogsError(messageOf(caught));
        } finally {
          if (mountedRef.current) setLogsLoading(false);
        }
      }, []);

      useEffect(() => {
        loadLogs();
      }, [loadLogs, reloadKey]);

      const doRestart = async () => {
        if (restartBusy) return;
        setRestartBusy(true);
        setRestartError(null);
        try {
          const payload = await api.restart();
          if (!mountedRef.current) return;
          setRestartOpen(false);
          setRestartDone(true);
          setRestartInstructions(typeof payload.instructions === 'string' ? payload.instructions : null);
        } catch (caught) {
          if (mountedRef.current) setRestartError(messageOf(caught));
        } finally {
          if (mountedRef.current) setRestartBusy(false);
        }
      };

      const formBody = form
        ? h(
            'div',
            { className: 'mb-form' },
            h(
              'div',
              { className: 'mb-form-row' },
              h(
                'div',
                { className: 'mb-form-text' },
                h('div', { className: 'mb-form-label' }, t('set.enabled')),
                h('div', { className: 'mb-hint' }, t('set.enabledHint')),
              ),
              h(Switch, { checked: form.enabled, label: t('set.enabled'), onChange: (next) => update({ enabled: next }) }),
            ),
            h(
              'div',
              { className: 'mb-form-grid' },
              h(SelectField, {
                label: t('set.interval'),
                value: String(form.intervalMinutes),
                options: INTERVAL_OPTIONS.map((value) => ({ value: String(value), label: intervalLabel(value, t) })),
                onChange: (next) => update({ intervalMinutes: Number(next) }),
                disabled: !form.enabled,
              }),
              h(SelectField, {
                label: t('set.keep'),
                value: String(form.keep),
                options: KEEP_OPTIONS.map((value) => ({ value: String(value), label: String(value) })),
                onChange: (next) => update({ keep: Number(next) }),
                hint: t('set.keepHint', { n: form.keep }),
              }),
              h(SelectField, {
                label: t('set.debounce'),
                value: String(form.debounceSeconds),
                options: DEBOUNCE_OPTIONS.map((value) => ({ value: String(value), label: debounceLabel(value, t) })),
                onChange: (next) => update({ debounceSeconds: Number(next) }),
                disabled: !form.watch,
              }),
            ),
            h(
              'div',
              { className: 'mb-form-row' },
              h(
                'div',
                { className: 'mb-form-text' },
                h('div', { className: 'mb-form-label' }, t('set.watch')),
                h('div', { className: 'mb-hint' }, t('set.watchHint')),
              ),
              h(Switch, { checked: form.watch, label: t('set.watch'), onChange: (next) => update({ watch: next }) }),
            ),
            saveError ? h(InlineError, { message: saveError }) : null,
            h(
              'div',
              { className: 'mb-form-foot' },
              h(Btn, { variant: 'primary', busy: saving, disabled: !dirty, onClick: save }, saving ? t('action.saving') : t('set.save')),
              dirty
                ? h('span', { className: 'mb-hint' }, t('set.dirty'))
                : saveNotice
                  ? h(
                      'span',
                      { className: 'mb-hint mb-hint-ok' },
                      saveNotice === 'local' ? t('set.savedLocal') : saveNotice === 'profile' ? t('set.savedProfile') : t('set.saved'),
                    )
                  : null,
            ),
          )
        : h(LoadingState, { t });

      const diagItems = [
        { key: t('set.diagDataDir'), value: overview?.dataDir ? h('code', { className: 'mb-code' }, overview.dataDir) : '—' },
        { key: t('set.diagSyncDir'), value: overview?.syncDir ? h('code', { className: 'mb-code' }, overview.syncDir) : '—' },
        { key: t('set.diagVersion'), value: overview?.version ? h('code', { className: 'mb-code' }, overview.version) : '—' },
      ];

      return h(
        'div',
        { className: 'mb-settings' },
        h(
          'div',
          { className: 'mb-settings-col' },
        h(Section, { title: t('set.schedule') }, formBody),
        h(
          Section,
          { title: t('set.restart') },
          h(
            'div',
            { className: 'mb-stack-tight' },
            h('div', { className: 'mb-hint' }, t('set.restartHint')),
            restartDone
              ? h('div', { className: 'mb-note' }, h(IconCheck, { size: 12 }), ' ', restartInstructions || t('set.restartRequested'))
              : null,
            restartError ? h(InlineError, { message: restartError || t('set.restartFailed') }) : null,
            h(
              'div',
              { className: 'mb-actions' },
              h(Btn, { variant: 'danger', disabled: restartDone, onClick: () => setRestartOpen(true) }, t('set.restart')),
            ),
          ),
        ),
        h(Section, { title: t('set.diag') }, h(KeyVal, { items: diagItems })),
        ),
        h(
          Section,
          {
            className: 'mb-fill',
            title: t('set.logs'),
            meta: t('set.logsLines', { n: LOG_LINES }),
            actions: h(Btn, { size: 'sm', busy: logsLoading, onClick: loadLogs }, logsLoading ? t('set.logsLoading') : t('set.logsRefresh')),
          },
          logsError ? h(InlineError, { message: logsError || t('set.logsError'), onRetry: loadLogs, retryLabel: t('action.retry') }) : null,
          h('pre', { className: 'mb-logs', ref: logsRef }, logs && logs.length > 0 ? logs.join('\n') : t('set.logsEmpty')),
        ),
        restartOpen
          ? h(ConfirmDialog, {
              t,
              title: t('set.restartTitle'),
              body: t('set.restartBody'),
              tone: 'danger',
              checkboxLabel: t('set.restartCheck'),
              confirmLabel: t('set.restart'),
              busy: restartBusy,
              error: restartError,
              onCancel: () => {
                if (!restartBusy) setRestartOpen(false);
              },
              onConfirm: doRestart,
            })
          : null,
      );
    }

    // ---------------------------------------------------------------------------------------
    // Page
    // ---------------------------------------------------------------------------------------

    function useMeasuredWidth() {
      const ref = useRef(null);
      const [width, setWidth] = useState(0);
      useEffect(() => {
        const element = ref.current;
        if (!element) return undefined;
        const update = () => setWidth(element.clientWidth || 0);
        update();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(update);
        observer.observe(element);
        return () => observer.disconnect();
      }, []);
      return [ref, width];
    }

    function TabPanel({ active, children }) {
      return h('div', { className: `mb-tabpanel${active ? '' : ' is-hidden'}`, role: 'tabpanel' }, children);
    }

    function MaintenancePage({ t, subscribeLocale }) {
      useLocaleTick(subscribeLocale);
      const { overview, error: overviewError, loading, reload } = useOverviewPolling();
      const [tab, setTab] = useState('overview');
      const [visited, setVisited] = useState({ overview: true });
      const [reloadKey, setReloadKey] = useState(0);
      const [notice, setNotice] = useState(null);
      const [backupBusy, setBackupBusy] = useState(false);
      const [ackBusy, setAckBusy] = useState(false);
      const [ackError, setAckError] = useState(null);
      const [archiveCount, setArchiveCount] = useState(null);
      const [rootRef, width] = useMeasuredWidth();
      const busyKind = busyKindOf(overview);

      useEffect(() => {
        setVisited((previous) => (previous[tab] ? previous : { ...previous, [tab]: true }));
      }, [tab]);

      const openTab = useCallback((next) => setTab(next), []);
      const refreshAll = useCallback(() => {
        setNotice(null);
        reload();
        setReloadKey((value) => value + 1);
      }, [reload]);

      const handleRefreshConnection = useCallback(async () => {
        await api.refreshConnection();
        await reload();
      }, [reload]);

      const handleLogin = useCallback(
        async (token) => {
          await api.login(token);
          await reload();
        },
        [reload],
      );

      const handleArchiveCount = useCallback((count) => {
        setArchiveCount(typeof count === 'number' ? count : null);
      }, []);

      const backupTask = overview?.backup?.task || null;
      const backupRunning = isTaskRunning(backupTask);
      const backupLabel = backupRunning
        ? t('action.backupBusy', {
            stage: backupTask?.stageLabel || t('result.running'),
            progress: Math.max(0, Math.min(100, Math.round(Number(backupTask?.progress) || 0))),
          })
        : t('action.backup');

      const startBackup = async () => {
        if (backupBusy || busyKind) return;
        setBackupBusy(true);
        setNotice(null);
        try {
          await api.startBackup(false);
          await reload();
        } catch (caught) {
          setNotice({ text: messageOf(caught) });
        } finally {
          setBackupBusy(false);
        }
      };

      const ack = async () => {
        if (ackBusy) return;
        setAckBusy(true);
        setAckError(null);
        try {
          await api.ackRestore();
          await reload();
        } catch (caught) {
          setAckError(messageOf(caught));
        } finally {
          setAckBusy(false);
        }
      };

      const restoreNotice = buildRestoreNotice(t, overview);
      const errorState = h(
        'div',
        { className: 'mb-state mb-state-empty' },
        h('span', { className: 'mb-state-icon' }, h(IconAlert, { size: 18 })),
        h('div', { className: 'mb-state-title' }, t('state.errorTitle')),
        h('div', { className: 'mb-state-body' }, overviewError || t('state.errorBody')),
        h(
          'div',
          { className: 'mb-actions' },
          h(Btn, { variant: 'primary', onClick: refreshAll }, t('action.retry')),
        ),
      );

      return h(
        'div',
        { className: `mb-root${width > 0 && width < 900 ? ' is-narrow' : ''}`, ref: rootRef, 'aria-label': t('page.aria') },
        h('style', null, CSS),
        h(
          'div',
          { className: 'mb-panel' },
          h(
            'div',
            { className: 'mb-header', 'data-window-drag': true },
            h(
              'div',
              { className: 'mb-brand' },
              h('span', { className: 'mb-brand-icon' }, h(MaintenanceIcon, { size: 16 })),
              h(
                'div',
                { className: 'mb-brand-text' },
                h('div', { className: 'mb-title' }, t('page.title')),
                h('div', { className: 'mb-subtitle' }, t('page.subtitle')),
              ),
            ),
            h(
              'div',
              { className: 'mb-header-actions' },
              busyKind ? h(Chip, { tone: 'brand' }, t(busyKind === 'backup' ? 'header.busyBackup' : 'header.busyRestore')) : null,
              h(
                Btn,
                {
                  variant: 'primary',
                  busy: backupBusy,
                  disabled: Boolean(busyKind) || backupBusy || !overview,
                  onClick: startBackup,
                  title: t('action.backup'),
                },
                backupRunning ? null : h(IconBackup),
                h('span', null, backupLabel),
              ),
              h(Btn, { onClick: refreshAll, title: t('action.refresh') }, h(IconRefresh), h('span', null, t('action.refresh'))),
            ),
          ),
          h(
            'div',
            { className: 'mb-body' },
            !overview
              ? loading && !overviewError
                ? h(LoadingState, { t })
                : errorState
              : h(
                  React.Fragment,
                  null,
                  h(RestoreNoticeBanner, { t, notice: restoreNotice, onClear: ack, clearing: ackBusy, error: ackError }),
                  overviewError
                    ? h(
                        'div',
                        { className: 'mb-banner is-error', role: 'alert' },
                        h('span', { className: 'mb-banner-icon' }, h(IconAlert, { size: 14 })),
                        h('div', { className: 'mb-banner-main' }, h('div', { className: 'mb-banner-body' }, overviewError)),
                        h(Btn, { size: 'sm', onClick: refreshAll }, t('action.retry')),
                      )
                    : null,
                  notice
                    ? h(
                        'div',
                        { className: 'mb-banner is-error', role: 'alert' },
                        h('span', { className: 'mb-banner-icon' }, h(IconAlert, { size: 14 })),
                        h('div', { className: 'mb-banner-main' }, h('div', { className: 'mb-banner-body' }, notice.text)),
                        h(
                          'button',
                          { type: 'button', className: 'mb-iconbtn', onClick: () => setNotice(null), 'aria-label': t('action.dismiss'), title: t('action.dismiss') },
                          h(IconClose),
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'mb-cards' },
                    h(ConnectionCard, {
                      t,
                      connection: overview.connection,
                      onRefreshConnection: handleRefreshConnection,
                      onLogin: handleLogin,
                    }),
                    h(LastBackupCard, { t, overview }),
                    h(SnapshotsCard, { t, overview, archiveCount, onOpen: openTab }),
                    h(NextBackupCard, { t, overview, onOpen: openTab }),
                  ),
                  h(
                    'div',
                    { className: 'mb-tabs', role: 'tablist', 'aria-label': t('tabs.aria') },
                    TABS.map((item) =>
                      h(
                        'button',
                        {
                          key: item.id,
                          type: 'button',
                          role: 'tab',
                          'aria-selected': tab === item.id,
                          className: `mb-tab${tab === item.id ? ' is-active' : ''}`,
                          onClick: () => openTab(item.id),
                        },
                        t(item.key),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'mb-tabbody' },
                    visited.overview
                      ? h(TabPanel, { active: tab === 'overview' }, h(OverviewTab, { t, overview, onOpenTab: openTab }))
                      : null,
                    visited.scope ? h(TabPanel, { active: tab === 'scope' }, h(ScopeTab, { t, reloadKey, busyKind })) : null,
                    visited.snapshots
                      ? h(
                          TabPanel,
                          { active: tab === 'snapshots' },
                          h(SnapshotsTab, {
                            t,
                            overview,
                            reloadKey,
                            busyKind,
                            onArchiveCount: handleArchiveCount,
                            onRefreshOverview: reload,
                          }),
                        )
                      : null,
                    visited.settings ? h(TabPanel, { active: tab === 'settings' }, h(SettingsTab, { t, overview, reloadKey, onRefreshOverview: reload })) : null,
                  ),
                ),
          ),
        ),
      );
    }

    // ---------------------------------------------------------------------------------------
    // Styles — DSH theme tokens only (no literal colors), prefix mb-
    // ---------------------------------------------------------------------------------------

    const CSS = `
.mb-root { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
  font-size: 13px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
.mb-root *, .mb-root *::before, .mb-root *::after { box-sizing: border-box; }
.mb-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.mb-header { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 52px; padding: 8px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
html[data-platform=darwin] .mb-header { min-height: max(52px, var(--dsh-frame-top-clearance, 0px)); padding-left: max(18px, calc(var(--dsh-frame-leading-clearance, 0px) + 8px)); }
.mb-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mb-brand-icon { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
.mb-brand-text { min-width: 0; }
.mb-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.mb-subtitle { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46vw; }
.mb-header-actions { display: flex; align-items: center; gap: 8px; flex: none; }
/* One screen: the page itself never scrolls. Only long content (tables, logs, lists) scrolls inside its own card. */
.mb-body { flex: 1 1 auto; min-height: 0; overflow: hidden; padding: 12px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.mb-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.mb-root ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 99px; }
.mb-root ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-scrollbar-bg-l1)); }
.mb-root ::-webkit-scrollbar-track { background: transparent; }
.mb-body > .mb-banner { flex: none; }

.mb-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; font-weight: 500; font-family: inherit; cursor: pointer;
  white-space: nowrap; transition: background .12s ease, border-color .12s ease, opacity .12s ease; }
.mb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.mb-btn:disabled { opacity: .55; cursor: default; }
.mb-btn-sm { padding: 4px 9px; font-size: 11.5px; border-radius: 7px; }
.mb-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.mb-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); filter: brightness(1.08); }
.mb-btn-danger { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); color: var(--dsw-alias-state-error-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.mb-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }
.mb-btn-ghost { border-color: transparent; color: var(--dsw-alias-label-secondary); padding-left: 8px; padding-right: 8px; }
.mb-btn-ghost:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.mb-linkbtn { border: 0; background: transparent; color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); font-family: inherit; font-size: inherit; padding: 0 2px; cursor: pointer; text-decoration: none; }
.mb-linkbtn:hover { text-decoration: underline; }
.mb-iconbtn { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex; align-items: center;
  justify-content: center; width: 22px; height: 22px; border-radius: 6px; flex: none; }
.mb-iconbtn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-spinner { display: inline-block; border: 1.6px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: mb-spin .8s linear infinite; flex: none; }
@keyframes mb-spin { to { transform: rotate(360deg); } }

.mb-cards { flex: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.mb-card { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 9px 12px 10px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.mb-card-head { display: flex; align-items: center; gap: 8px; min-height: 20px; }
.mb-card-title { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 11.5px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.mb-card-title svg { opacity: .85; }
.mb-card-meta { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mb-card-action { flex: none; display: inline-flex; align-items: center; }
.mb-card-action .mb-btn { font-size: 11px; }
.mb-card-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.mb-statusline { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 13px; }
.mb-status { font-weight: 600; white-space: nowrap; }
.mb-status-success { color: var(--dsw-alias-state-success-primary); }
.mb-status-warn { color: var(--dsw-alias-state-warn-primary); }
.mb-status-error { color: var(--dsw-alias-state-error-primary); }
.mb-status-muted { color: var(--dsw-alias-label-secondary); }
.mb-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); display: inline-block; }
.mb-dot-success { background: var(--dsw-alias-state-success-primary); }
.mb-dot-warn { background: var(--dsw-alias-state-warn-primary); }
.mb-dot-error { background: var(--dsw-alias-state-error-primary); }
.mb-dot-brand { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.mb-dot.is-pulse { animation: mb-pulse 1.4s ease-in-out infinite; }
@keyframes mb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.mb-chip { flex: none; display: inline-flex; align-items: center; border-radius: 999px; padding: 0 7px; font-size: 10px; line-height: 1.75;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.mb-chip-brand { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 9%, transparent); }
.mb-chip-success { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent); }
.mb-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.mb-chip-error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.mb-big { font-size: 17px; font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mb-big.is-muted { color: var(--dsw-alias-label-secondary); font-size: 14px; }
.mb-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.5; overflow-wrap: anywhere; }
.mb-hint-error { color: var(--dsw-alias-state-error-primary); }
.mb-hint-warn { color: var(--dsw-alias-state-warn-primary); }
.mb-hint-ok { color: var(--dsw-alias-state-success-primary); }
.mb-hint-watch.is-on { color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.mb-inline-row { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12px; }
.mb-inline-label { color: var(--dsw-alias-label-secondary); flex: none; }
.mb-inline-value { font-weight: 600; min-width: 0; }
.mb-bar-row { display: flex; flex-direction: column; gap: 3px; }
.mb-bar { height: 5px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.mb-bar-fill { display: block; height: 100%; border-radius: 99px; background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); transition: width .2s ease; }
.mb-bar-fill.is-warn { background: var(--dsw-alias-state-warn-primary); }
.mb-bar-text { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.mb-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; min-width: 0; }
.mb-row-label { color: var(--dsw-alias-label-secondary); flex: none; }
.mb-row-value { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mb-row-hint { margin-left: auto; font-size: 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); white-space: nowrap; }
.mb-inline-actions { display: flex; align-items: center; gap: 8px; }
.mb-reauth { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-reauth-title { font-size: 11.5px; font-weight: 600; }
.mb-reauth-row { display: flex; align-items: center; gap: 6px; }
.mb-input { flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; }
.mb-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 1px; }
.mb-command { display: block; padding: 6px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2));
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.mb-inline-error { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-radius: 8px; font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.mb-inline-error-text { min-width: 0; overflow-wrap: anywhere; }
.mb-inline-error-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; flex: none; }
.mb-inline-error .mb-linkbtn { color: inherit; }

.mb-banner { display: flex; align-items: flex-start; gap: 9px; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.mb-banner.is-warn { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); }
.mb-banner.is-info { border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 7%, transparent); }
.mb-banner.is-error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
.mb-banner-icon { flex: none; margin-top: 1px; color: var(--dsw-alias-label-secondary); }
.mb-banner.is-warn .mb-banner-icon { color: var(--dsw-alias-state-warn-primary); }
.mb-banner.is-info .mb-banner-icon { color: var(--dsw-alias-state-success-primary); }
.mb-banner.is-error .mb-banner-icon { color: var(--dsw-alias-state-error-primary); }
.mb-banner-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; }
.mb-banner-title { font-size: 12.5px; font-weight: 600; }
.mb-banner-body { font-size: 11.5px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.mb-banner-targets { font-size: 10.5px; }
.mb-banner-error { font-size: 11px; color: var(--dsw-alias-state-error-primary); }
.mb-banner-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.mb-banner-path { max-width: 220px; font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10px; color: var(--dsw-alias-label-secondary); }
.mb-note { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }

.mb-tabs { flex: none; display: flex; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-tab { border: 0; border-bottom: 2px solid transparent; border-radius: 7px 7px 0 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12.5px; font-family: inherit; padding: 6px 12px 8px; cursor: pointer; white-space: nowrap; transition: color .12s ease, background .12s ease; }
.mb-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-tab.is-active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); font-weight: 600; }
.mb-tabbody { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.mb-tabpanel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; overflow-x: hidden; }
.mb-tabfill { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.mb-tabfill > * { flex: none; }
.mb-tabfill > .mb-scroll, .mb-tabfill > .mb-split { flex: 1 1 auto; min-height: 0; }
.mb-scroll { overflow: auto; }
.mb-ov { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.mb-ov-grid { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr) minmax(0, 1.15fr); gap: 10px; align-items: start; }
.mb-ov-grid > .mb-section { max-height: 100%; }
.mb-fill { min-height: 0; }
.mb-fill-body { flex: 0 1 auto; min-height: 0; overflow-y: auto; }
.mb-settings > .mb-fill { align-self: stretch; }
.mb-ok-line { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-state-success-primary); }
.mb-ov-facts { flex: none; display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.mb-fact { display: flex; align-items: baseline; gap: 10px; min-width: 0; padding: 5px 8px; margin: 0 -8px; border: 0; border-radius: 7px; background: transparent;
  color: inherit; font-family: inherit; text-align: left; cursor: pointer; }
.mb-fact:hover:not(.is-static) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-fact.is-static { cursor: default; }
.mb-fact-label { flex: none; width: 64px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mb-fact-value { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mb-list-tips li { flex-direction: column; align-items: flex-start; gap: 3px; }
.mb-split { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(340px, 1fr); gap: 10px; }
.mb-split-list, .mb-split-detail { min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.mb-split-list > * { flex: 1 1 auto; min-height: 0; }
.mb-split-list > .mb-state { flex: none; }
.mb-split-detail > .mb-detail { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.mb-settings { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.mb-settings-col { min-height: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.mb-settings-col > * { flex: none; }
.mb-settings > .mb-fill .mb-logs { flex: 1 1 auto; min-height: 0; max-height: none; }
.mb-scope-foot { display: flex; flex-direction: column; gap: 6px; }
.mb-scope-foot:empty { display: none; }
.mb-tabpanel.is-hidden { display: none; }
.mb-stack { display: flex; flex-direction: column; gap: 10px; }
.mb-stack-tight { display: flex; flex-direction: column; gap: 8px; }
.mb-section { display: flex; flex-direction: column; gap: 8px; padding: 11px 14px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.mb-section-head { display: flex; align-items: center; gap: 8px; }
.mb-section-title { font-size: 13px; font-weight: 650; }
.mb-section-meta { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.mb-section-actions { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.mb-section-lead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.mb-section-lead-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mb-summary-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.mb-mini { display: flex; flex-direction: column; gap: 2px; min-width: 0; text-align: left; padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: inherit; font-family: inherit; }
.mb-mini:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-mini-title { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.mb-mini-value { font-size: 12.5px; font-weight: 600; }
.mb-mini-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.mb-overview-foot { margin-top: 2px; }
.mb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mb-list li { display: flex; align-items: baseline; gap: 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); min-width: 0; }
.mb-list-warn li { color: var(--dsw-alias-state-warn-primary); }
.mb-list-warn li svg { flex: none; }
.mb-list-text { min-width: 0; overflow-wrap: anywhere; }
.mb-code { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; padding: 1px 5px; border-radius: 5px;
  background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.mb-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mb-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mb-actions-end { justify-content: flex-end; }
.mb-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 2px 0; }

.mb-tablewrap { overflow: auto; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.mb-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 11.5px; }
.mb-table-scope { min-width: 720px; table-layout: fixed; }
.mb-table-scope th:nth-child(1) { width: 20%; }
.mb-table-scope th:nth-child(2) { width: 27%; } .mb-table-scope th:nth-child(3) { width: 19%; }
.mb-table-scope th:nth-child(4) { width: 8%; } .mb-table-scope th:nth-child(5) { width: 9%; }
.mb-table-scope th:nth-child(6) { width: 9%; }
.mb-table-scope .mb-pathcell { max-width: none; }
.mb-table-snap { min-width: 420px; }
.mb-snapcell { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mb-snapcell-date { font-weight: 600; font-variant-numeric: tabular-nums; }
.mb-snapcell-name { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.mb-split-detail .mb-radios { grid-template-columns: minmax(0, 1fr); gap: 8px; }
.mb-split-detail .mb-radio { align-items: center; }
.mb-split-detail .mb-radio-text { flex-direction: row; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mb-table-snap .mb-td { white-space: nowrap; vertical-align: middle; }
.mb-table-snap .mb-td:first-child .mb-code { display: inline-block; max-width: 230px; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.mb-th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 500; color: var(--dsw-alias-label-secondary); font-size: 10.5px; padding: 8px 10px 7px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; background: var(--dsw-alias-bg-layer-1); }
.mb-tr > .mb-td { border-bottom: 1px solid var(--dsw-alias-border-l1); }
.mb-tr:last-child > .mb-td { border-bottom: 0; }
.mb-tr:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-tr.is-clickable { cursor: pointer; }
.mb-tr.is-active { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent); }
.mb-tr.is-off { opacity: .62; }
.mb-tr.is-warn { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent); }
.mb-td { padding: 7px 10px; vertical-align: top; }
.mb-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mb-col-toggle { width: 72px; text-align: right; }
.mb-pathcell { max-width: 250px; }
.mb-pathcell .mb-code { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mb-cell-name { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 600; }
.mb-cell-warn { display: inline-flex; align-items: center; gap: 4px; margin-top: 2px; font-size: 10.5px; color: var(--dsw-alias-state-error-primary); }
.mb-readcell { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.mb-totals { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.mb-switch { width: 34px; height: 20px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  position: relative; cursor: pointer; padding: 0; flex: none; transition: background .12s ease, border-color .12s ease; }
.mb-switch::after { content: ""; position: absolute; top: 50%; left: 2px; transform: translateY(-50%); width: 14px; height: 14px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, var(--dsw-alias-label-secondary)); transition: left .12s ease; }
.mb-switch[aria-checked="true"] { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); border-color: transparent; }
.mb-switch[aria-checked="true"]::after { left: 17px; background: #fff; }
.mb-switch:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
.mb-switch:disabled { opacity: .5; cursor: default; }
.mb-switchrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-switchrow-text { min-width: 0; }
.mb-switchrow-label { font-size: 12px; font-weight: 600; }

.mb-form { display: flex; flex-direction: column; gap: 10px; }
.mb-form-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-form-text { min-width: 0; }
.mb-form-label { font-size: 12px; font-weight: 600; }
.mb-form-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.mb-form-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mb-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mb-field-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mb-field-hint { font-size: 10.5px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.mb-select { height: 28px; padding: 0 26px 0 9px; border-radius: 7px; font-family: inherit; font-size: 12px; color: var(--dsw-alias-label-primary);
  background-color: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2)); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-secondary) 50%), linear-gradient(135deg, var(--dsw-alias-label-secondary) 50%, transparent 50%);
  background-position: calc(100% - 13px) 50%, calc(100% - 9px) 50%; background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
.mb-select:disabled { opacity: .55; cursor: default; }
.mb-check { display: inline-flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mb-radios { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.mb-radio { display: flex; align-items: flex-start; gap: 7px; text-align: left; padding: 8px 10px; border-radius: 9px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; }
.mb-radio:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }
.mb-radio.is-active { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent); }
.mb-radio:disabled { opacity: .55; cursor: default; }
.mb-radio-mark { width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--dsw-alias-border-l2); flex: none; margin-top: 2px; }
.mb-radio.is-active .mb-radio-mark { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  box-shadow: inset 0 0 0 3px var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.mb-radio-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mb-radio-label { font-size: 12px; font-weight: 600; }
.mb-radio-hint { font-size: 10.5px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }

.mb-detail { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; background: var(--dsw-alias-bg-layer-1); }
.mb-detail-empty { color: var(--dsw-alias-label-secondary); font-size: 12px; align-items: center; justify-content: center; text-align: center; }
.mb-detail-empty .mb-state-icon { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.mb-detail-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mb-detail-title { display: inline-flex; align-items: center; gap: 7px; min-width: 0; font-size: 12.5px; font-weight: 600; }
.mb-detail-head .mb-btn { margin-left: auto; }
.mb-subtitle { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mb-danger-box { display: flex; align-items: flex-start; gap: 7px; padding: 8px 10px; border-radius: 9px; font-size: 11.5px;
  color: var(--dsw-alias-state-error-primary); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.mb-manifest { display: flex; flex-direction: column; gap: 7px; padding: 10px 11px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-manifest-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mb-manifest-title { font-size: 11.5px; font-weight: 600; }
.mb-manifest-stats { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.mb-manifest-sub { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.mb-manifest-entries { display: flex; flex-direction: column; gap: 3px; }
.mb-manifest-entry { display: flex; align-items: baseline; gap: 10px; font-size: 11px; min-width: 0; }
.mb-manifest-entry-meta { margin-left: auto; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.mb-loading-box { display: flex; align-items: flex-start; gap: 9px; padding: 10px 11px; border-radius: 9px; border: 1px dashed var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary); font-size: 12px; }
.mb-loading-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mb-applied { display: flex; flex-direction: column; gap: 8px; padding: 11px 13px 12px; border-radius: 11px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
.mb-applied-head { display: flex; align-items: flex-start; gap: 8px; }
.mb-applied-icon { color: var(--dsw-alias-state-success-primary); flex: none; margin-top: 2px; }
.mb-applied-title { font-size: 12.5px; font-weight: 650; }
.mb-applied-path { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 11px; }
.mb-applied-path-label { color: var(--dsw-alias-label-secondary); }
.mb-diff { display: flex; flex-direction: column; gap: 8px; padding: 11px 12px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.mb-diff-title { font-size: 12px; font-weight: 650; }
.mb-diff-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.mb-diff-stat { display: flex; flex-direction: column; gap: 1px; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.mb-diff-stat-value { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; }
.mb-diff-stat-label { font-size: 10px; color: var(--dsw-alias-label-secondary); }
.mb-diff-stat.is-added .mb-diff-stat-value { color: var(--dsw-alias-state-success-primary); }
.mb-diff-stat.is-overwritten .mb-diff-stat-value { color: var(--dsw-alias-state-warn-primary); }
.mb-diff-stat.is-deleted .mb-diff-stat-value { color: var(--dsw-alias-state-error-primary); }
.mb-diff-stat.is-neutral .mb-diff-stat-value { color: var(--dsw-alias-label-secondary); }
.mb-diff-bytes { font-variant-numeric: tabular-nums; }
.mb-diff-groups { display: flex; flex-direction: column; gap: 4px; }
.mb-diff-group { border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); overflow: hidden; }
.mb-diff-group-head { width: 100%; display: flex; align-items: center; gap: 7px; padding: 5px 9px; border: 0; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 11.5px; cursor: pointer; text-align: left; }
.mb-diff-group-title { font-weight: 600; }
.mb-diff-group-count { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.mb-diff-group.is-added .mb-diff-group-title { color: var(--dsw-alias-state-success-primary); }
.mb-diff-group.is-overwritten .mb-diff-group-title { color: var(--dsw-alias-state-warn-primary); }
.mb-diff-group.is-deleted .mb-diff-group-title { color: var(--dsw-alias-state-error-primary); }
.mb-diff-items { list-style: none; margin: 0; padding: 5px 9px 6px; display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
.mb-diff-items li { font-size: 10.5px; }
.mb-diff-group-body { padding: 4px 9px 6px; }
.mb-diff-block { display: flex; flex-direction: column; gap: 3px; }
.mb-diff-block-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mb-diff-target { display: flex; align-items: baseline; gap: 7px; font-size: 10.5px; min-width: 0; }
.mb-diff-arrow { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); flex: none; }
.mb-logs { margin: 0; max-height: 280px; overflow: auto; min-height: 120px; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-secondary);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 10.5px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.mb-keyvals { display: flex; flex-direction: column; gap: 5px; margin: 0; }
.mb-keyval { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.mb-keyval-key { flex: none; width: 82px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mb-keyval-value { margin: 0; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
.mb-collapsible { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.mb-collapsible-head { width: 100%; display: flex; align-items: center; gap: 7px; padding: 7px 10px; border: 0; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 11.5px; cursor: pointer; text-align: left; }
.mb-collapsible-head:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.mb-collapsible-title { font-weight: 600; }
.mb-collapsible-meta { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.mb-collapsible-body { padding: 4px 12px 10px; }
.mb-list-excluded li { font-size: 10.5px; }

.mb-state { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); }
.mb-state-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.mb-state-body { font-size: 11.5px; color: var(--dsw-alias-label-secondary); max-width: 520px; line-height: 1.55; }
.mb-state-icon { width: 36px; height: 36px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 12%, transparent); }
.mb-state-empty .mb-state-icon { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }

.mb-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent); }
.mb-dialog { width: min(520px, 100%); max-height: min(86vh, 640px); overflow: auto; display: flex; flex-direction: column; gap: 11px;
  padding: 16px 17px 14px; border-radius: 13px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  box-shadow: 0 18px 48px color-mix(in srgb, var(--dsw-alias-label-primary) 26%, transparent); }
.mb-dialog:focus-visible { outline: none; }
.mb-dialog-title { font-size: 14px; font-weight: 650; }
.mb-dialog-body { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.mb-dialog-effects { display: flex; flex-direction: column; gap: 5px; }
.mb-dialog-effects-list { display: flex; flex-direction: column; gap: 3px; }
.mb-dialog-effects-title { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.mb-dialog-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }

/* ---- Comfortable density: larger type, consistent spacing (overrides the compact base rules above) ---- */
.mb-root { font-size: 13.5px; line-height: 1.55; }
.mb-header { min-height: 64px; padding: 12px 24px; }
html[data-platform=darwin] .mb-header { min-height: max(64px, var(--dsh-frame-top-clearance, 0px)); padding-left: max(24px, calc(var(--dsh-frame-leading-clearance, 0px) + 8px)); }
.mb-brand { gap: 12px; }
.mb-brand-icon { width: 36px; height: 36px; border-radius: 10px; }
.mb-title { font-size: 17px; }
.mb-subtitle { font-size: 12.5px; margin-top: 2px; }
.mb-header-actions { gap: 10px; }
.mb-btn { padding: 7px 14px; font-size: 13px; border-radius: 9px; }
.mb-btn-sm { padding: 5px 11px; font-size: 12px; border-radius: 8px; }
.mb-body { padding: 18px 24px 20px; gap: 16px; }
.mb-cards { gap: 14px; }
.mb-card { gap: 8px; padding: 14px 16px 15px; border-radius: 14px; }
.mb-card-head { min-height: 26px; gap: 10px; margin-bottom: 2px; }
.mb-card-title { font-size: 12.5px; gap: 8px; }
.mb-card-icon { width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 11%, transparent); }
.mb-card-icon svg { opacity: 1; }
.mb-card-meta { font-size: 11px; }
.mb-card-action .mb-btn { font-size: 12px; padding: 4px 8px; }
.mb-card-body { gap: 6px; }
.mb-card-value { font-size: 20px; }
.mb-card-value .mb-status { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
.mb-card-value .mb-dot { width: 9px; height: 9px; }
.mb-card-value-aside { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.mb-card-sub { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.mb-big { font-size: 22px; line-height: 1.3; }
.mb-big.is-muted { font-size: 17px; }
.mb-hint { font-size: 12px; line-height: 1.55; }
.mb-bar { height: 6px; }
.mb-bar-row { gap: 6px; margin-top: 2px; }
.mb-bar-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mb-chip { font-size: 11px; padding: 0 8px; line-height: 1.8; }
.mb-tabs { gap: 6px; }
.mb-tab { font-size: 13.5px; padding: 8px 14px 10px; }
.mb-tabpanel, .mb-tabfill { gap: 14px; }
.mb-section { gap: 12px; padding: 16px 18px; border-radius: 14px; }
.mb-section-title { font-size: 14px; }
.mb-section-meta { font-size: 11.5px; }
.mb-section-lead-text .mb-section-title { font-size: 15px; }
.mb-list { gap: 9px; }
.mb-list li { font-size: 12.5px; }
.mb-code { font-size: 11.5px; padding: 2px 6px; }
.mb-ov { gap: 14px; }
.mb-ov-grid { grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 14px; align-items: stretch; }
.mb-ov-grid > .mb-section { max-height: none; }
.mb-fill-body { flex: 1 1 auto; }
.mb-health { flex: none; display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1); }
.mb-health.is-ok { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 6%, transparent); }
.mb-health.is-warn { align-items: flex-start; border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, transparent); }
.mb-health-icon { width: 34px; height: 34px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; }
.mb-health.is-ok .mb-health-icon { background: var(--dsw-alias-state-success-primary); }
.mb-health.is-warn .mb-health-icon { background: var(--dsw-alias-state-warn-primary); }
.mb-health-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.mb-health-title { font-size: 14.5px; font-weight: 650; }
.mb-health-body { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.mb-health-list { margin-top: 4px; max-height: 96px; overflow-y: auto; }
.mb-health-facts { flex: none; display: flex; gap: 8px; }
.mb-health .mb-fact { flex-direction: column; align-items: flex-start; gap: 2px; margin: 0; padding: 8px 14px; min-width: 120px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-base); }
.mb-health .mb-fact-label { width: auto; font-size: 11.5px; }
.mb-health .mb-fact-value { font-size: 13px; }
.mb-protect-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-content: start; }
.mb-protect { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); min-width: 0; }
.mb-protect-path { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; font-weight: 600; overflow-wrap: anywhere; }
.mb-protect-desc { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }
.mb-tips { margin: 0; padding: 0; list-style: none; counter-reset: tip; display: flex; flex-direction: column; gap: 14px; }
.mb-tips li { counter-increment: tip; position: relative; padding-left: 32px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.mb-tips li::before { content: counter(tip); position: absolute; left: 0; top: 0; width: 22px; height: 22px; border-radius: 50%; font-size: 11.5px; font-weight: 600;
  display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 11%, transparent); }
.mb-table { font-size: 12.5px; }
.mb-th { font-size: 11.5px; padding: 10px 12px 9px; }
.mb-td { padding: 10px 12px; }
.mb-tablewrap { border-radius: 14px; }
.mb-split { gap: 14px; }
.mb-detail { gap: 14px; padding: 16px 18px 18px; border-radius: 14px; }
.mb-detail-title { font-size: 13.5px; }
.mb-radios { gap: 10px; }
.mb-radio { padding: 10px 12px; }
.mb-radio-label, .mb-switchrow-label, .mb-form-label { font-size: 13px; }
.mb-radio-hint { font-size: 11.5px; }
.mb-switchrow, .mb-form-row { padding: 11px 14px; border-radius: 11px; }
.mb-form { gap: 14px; }
.mb-form-grid { gap: 14px; }
.mb-field-label { font-size: 12px; }
.mb-select, .mb-input { height: 32px; font-size: 12.5px; border-radius: 8px; }
.mb-settings { gap: 14px; }
.mb-settings-col { gap: 14px; }
.mb-logs { font-size: 11.5px; line-height: 1.7; padding: 12px 14px; border-radius: 11px; }
.mb-keyvals { gap: 8px; }
.mb-keyval-key { width: 92px; font-size: 12px; }
.mb-keyval-value { font-size: 12px; }
.mb-totals { font-size: 12px; }
.mb-collapsible { border-radius: 11px; }
.mb-collapsible-head { padding: 9px 12px; font-size: 12.5px; }
@media (max-width: 1180px) { .mb-health { flex-wrap: wrap; } .mb-health-facts { width: 100%; } .mb-health .mb-fact { flex: 1; } }
.mb-switch { width: 36px; height: 21px; border-color: transparent; background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8b949e) 45%, transparent); }
.mb-switch::after { width: 15px; height: 15px; left: 3px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.mb-switch[aria-checked="true"]::after { left: 18px; }
.mb-protect-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.mb-root.is-narrow .mb-subtitle { display: none; }
.mb-root.is-narrow .mb-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mb-root.is-narrow .mb-protect-grid { grid-template-columns: minmax(0, 1fr); }
.mb-root.is-narrow .mb-ov-grid, .mb-root.is-narrow .mb-split, .mb-root.is-narrow .mb-settings { grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(min-content, max-content); }
.mb-root.is-narrow .mb-ov-grid, .mb-root.is-narrow .mb-settings { overflow-y: auto; }
.mb-root.is-narrow .mb-split { grid-template-rows: minmax(160px, 40%) minmax(0, 1fr); }
.mb-root.is-narrow .mb-summary-grid { grid-template-columns: minmax(0, 1fr); }
.mb-root.is-narrow .mb-form-grid { grid-template-columns: minmax(0, 1fr); }
.mb-root.is-narrow .mb-radios { grid-template-columns: minmax(0, 1fr); }
.mb-root.is-narrow .mb-diff-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mb-root.is-narrow .mb-header { flex-wrap: wrap; }
@media (max-width: 1100px) { .mb-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) {
  .mb-summary-grid, .mb-form-grid, .mb-radios { grid-template-columns: minmax(0, 1fr); }
  .mb-diff-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mb-subtitle { display: none; }
  .mb-body { padding: 10px 12px 14px; }
}
`;

    // ---------------------------------------------------------------------------------------
    // Mount
    // ---------------------------------------------------------------------------------------

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
              MaintenanceIcon,
            ),
          ),
        );
        disposers.push(
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                inject: () => ({ t, subscribeLocale }),
              },
              MaintenancePage,
            ),
          ),
        );
      } catch (error) {
        console.error('[dsh-maintenance] panel registration failed:', error);
      }

      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              // ignore
            }
          }
        },
        'dsh-maintenance: ui mounts',
      );
    }

    return { inject, apply };
  },
});
