/**
 * 真实云端快照 → 沙箱 HOME 的两阶段还原 E2E（不触碰真实 ~/.dsh）。
 *
 *   node test/restore-e2e-cloud.mjs
 *
 * 步骤：选择一个带 sidecar 的云端快照 → preview（只下小清单）→ stage（下载 tar、解压、
 * 差异）→ apply（安全副本 + rsync 到沙箱）→ 校验落盘/运行态保护 → finalize（重启收尾）
 * → rollback（用安全副本恢复沙箱原文件）。
 *
 * 沙箱：/tmp/dsh-restore-e2e-<pid>/home（DSH_HOME / DSH_WORKSPACE_DIR / DSH_SYNC_DIR 均在沙箱内）。
 * 结束后默认清理；DSH_RESTORE_E2E_KEEP=1 可保留排查。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = `/tmp/dsh-restore-e2e-${process.pid}`;
const sandboxHome = join(root, 'home');
const dshHome = join(sandboxHome, '.dsh');
const workspace = join(sandboxHome, 'Documents', 'workspace');
const syncDir = join(sandboxHome, '.dsh-sync');
const dataDir = join(root, 'maintenance');
const profileDir = join(dshHome, 'profiles', 'desktop');

// 只把 workspace / 运行态目录指向沙箱；DSH_HOME 保持真实，保证夸克 CLI 可用。
// restore scope='workspace' 时不会触碰 ~/.dsh。
process.env.DSH_WORKSPACE_DIR = workspace;
process.env.DSH_SYNC_DIR = syncDir;
process.env.DSH_MAINTENANCE_DIR = dataDir;
process.env.DSH_PROFILE_DIR = profileDir;

const pluginsDir = join(workspace, 'dsh', 'plugins');
const selfDir = join(workspace, 'dsh-maintenance-backup');
for (const dir of [
  pluginsDir,
  join(pluginsDir, 'node_modules', 'keep'),
  join(pluginsDir, '.git'),
  join(workspace, 'dsh-page-preview'),
  join(workspace, 'overview', 'dsh-agent-usage'),
  selfDir,
  syncDir,
  join(syncDir, 'logs'),
  profileDir,
]) {
  mkdirSync(dir, { recursive: true });
}

// 还原前的沙箱“旧插件工程”与运行态：应被安全副本覆盖 / 被保护
writeFileSync(join(pluginsDir, 'package.json'), '{"name":"sandbox-old-plugin"}\n');
writeFileSync(join(pluginsDir, 'old.file'), 'old-plugin\n');
writeFileSync(join(pluginsDir, 'node_modules', 'keep', 'keep.txt'), 'node_modules-must-survive\n');
writeFileSync(join(pluginsDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
writeFileSync(join(selfDir, 'keep.txt'), 'self-package-should-not-be-touched\n');
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# sandbox old patch\n');

const { createCore } = await import('../host/core.js');
const { createQuark } = await import('../host/quark.js');
const { createRestoreEngine } = await import('../host/restore.js');

const asked = [];
const fakeCtx = {
  get: () => undefined,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};
const core = createCore(fakeCtx);
const quark = createQuark(core);
const restore = createRestoreEngine({
  core,
  quark,
  logger: (message) => console.log('[engine]', message),
  resolveSources: async () => {
    // 沙箱里只映射 workspace 子目录；config 范围不涉及 workspace
    return [
      { src: join(workspace, 'dsh', 'plugins'), dest: 'workspace/plugins' },
      { src: join(workspace, 'dsh-page-preview'), dest: 'workspace/dsh-page-preview' },
      { src: join(workspace, 'overview', 'dsh-agent-usage'), dest: 'workspace/dsh-agent-usage' },
      { src: join(workspace, 'dsh-maintenance-backup'), dest: 'workspace/dsh-maintenance-backup' },
    ];
  },
});

const log = (label, value) => {
  console.log(`\n=== ${label} ===`);
  if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const snapshots = await restore.listSnapshots({ refresh: true });
log('云端快照', snapshots.map((s) => ({ name: s.name, size: s.size, sidecar: Boolean(s.sidecarFid) })));
const target = snapshots.find((s) => s.sidecarFid) || snapshots[0];
if (!target) throw new Error('云端没有快照，无法测试');

const preview = await restore.preview({ name: target.name });
log('sidecar 预览', {
  available: preview.available,
  source: preview.source,
  fileCount: preview.manifest?.file_count,
  sha: preview.manifest?.archive_sha256?.slice(0, 16),
  entries: preview.manifest?.entries?.length,
});
if (!preview.available) throw new Error('sidecar 预览不可用');

const staging = await restore.stage({ name: target.name, scope: 'workspace', includeSelf: false });
log('stage/diff', {
  stagingId: staging.stagingId,
  dir: staging.dir,
  counts: staging.diff.counts,
  targets: staging.diff.targets,
  protected: staging.diff.protected.slice(0, 5),
  warnings: staging.diff.warnings,
});
if (!(staging.diff.counts.added > 0)) throw new Error('workspace 范围差异应有新增文件');
if (existsSync(join(pluginsDir, 'dsh'))) throw new Error('stage 不应修改目标目录');
if (preview.manifest?.file_count && !(preview.manifest.file_count > 0)) throw new Error('sidecar file_count 异常');

const beforeOldFile = readFileSync(join(pluginsDir, 'old.file'), 'utf8');

const applied = await restore.apply({ stagingId: staging.stagingId, scope: 'workspace', includeSelf: false });
log('apply', {
  ok: applied.ok,
  restartRequired: applied.restartRequired,
  selfSkipped: applied.selfSkipped,
  safety: applied.safety,
  appliedTargets: applied.applied?.length,
  warnings: applied.warnings,
});
if (!applied.ok || !applied.restartRequired) throw new Error('apply 未返回 restartRequired');
if (!existsSync(join(pluginsDir, 'dsh-agent-assets', 'package.json'))) throw new Error('apply 后插件工程未落地');
if (existsSync(join(pluginsDir, 'old.file'))) throw new Error('apply 应删除快照里不存在的旧文件');
if (!existsSync(join(pluginsDir, 'node_modules', 'keep', 'keep.txt'))) throw new Error('node_modules 被删除（保护失败）');
if (!existsSync(join(pluginsDir, '.git', 'HEAD'))) throw new Error('.git 被删除（保护失败）');
if (!existsSync(join(selfDir, 'keep.txt'))) throw new Error('维护插件自身被覆盖（self 保护失败）');
if (!existsSync(join(syncDir, 'logs'))) throw new Error('dsh-sync/logs 运行态被删除（保护失败）');
if (existsSync(join(pluginsDir, 'old.file'))) throw new Error('apply 后旧文件应被删除');
const markerAfterApply = await restore.inspectPending();
if (!markerAfterApply || markerAfterApply.phase !== 'applied') throw new Error('apply 后 marker 应为 applied 且保留');
if (!existsSync(join(staging.dir))) throw new Error('apply 不应清理 staging');

const sameProcess = await restore.finalizeOnStartup();
log('finalizeOnStartup（同进程，应保留 marker）', { marker: Boolean(sameProcess.marker), sameProcess: sameProcess.sameProcess });
if (!sameProcess.sameProcess) throw new Error('同进程 finalize 应跳过');
if (!(await restore.inspectPending())) throw new Error('同进程不应清除 marker');
// 模拟 DSH 重启（新 Host 进程 pid 不同）
const markerPath = join(dataDir, 'restore', 'pending.json');
const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
marker.applyPid = -1;
writeFileSync(markerPath, JSON.stringify(marker));
const finalized = await restore.finalizeOnStartup();
log('finalizeOnStartup（模拟重启）', { marker: Boolean(finalized.marker), result: finalized.result });
if (await restore.inspectPending()) throw new Error('finalize 后 marker 应删除');
if (!finalized.result) throw new Error('finalize 未产出上次还原结果');
const stateAfter = core.getState();
if (!stateAfter.lastRestore) throw new Error('finalize 未写 lastRestore');

const rolledBack = await restore.rollback();
log('rollback', rolledBack);
if (!rolledBack.ok) throw new Error('rollback 失败');
if (!existsSync(join(pluginsDir, 'old.file')) || readFileSync(join(pluginsDir, 'old.file'), 'utf8') !== beforeOldFile) {
  throw new Error('rollback 未恢复安全副本里的旧文件');
}
if (!existsSync(join(selfDir, 'keep.txt'))) throw new Error('rollback 触碰了维护插件自身');
log('PASS', '云端快照 → 沙箱两阶段还原 + 安全副本回滚 全部通过');

restore.ackPending?.();
if (process.env.DSH_RESTORE_E2E_KEEP !== '1') {
  rmSync(root, { recursive: true, force: true });
  console.log('\n沙箱已清理:', root);
} else {
  console.log('\n沙箱保留:', root);
}
