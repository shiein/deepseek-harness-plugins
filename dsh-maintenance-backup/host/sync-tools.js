/**
 * 备份工具脚本自愈。
 *
 * 插件依赖 ~/.dsh-sync 下的新版 sync.sh / scope.sh / sidecar 工具。若快照还原把
 * ~/.dsh-sync 覆盖成旧版本（或新机器上缺失），这里用插件 assets/dsh-sync 里的
 * 同名文件补齐；旧文件保留为 *.pre-maintenance.bak。
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { IS_WINDOWS } from './platform.js';

const TOOLS = [
  { name: 'sync.sh', version: 2, executable: true },
  { name: 'scope.sh', version: 2, executable: true },
  { name: 'scope-report.cjs', version: 2, executable: false },
  { name: 'make-sidecar.cjs', version: 2, executable: false },
  { name: 'parse-browse.cjs', version: 2, executable: false },
  { name: 'discover-link-entries.cjs', version: 2, executable: false },
];

/** @param {string} text */
function versionOf(text) {
  const match = /@dsh-maintenance-tools-version\s+(\d+)/.exec(String(text || ''));
  return match ? Number(match[1]) : 0;
}

/** @param {ReturnType<import('./core.js').createCore>} core */
export function createSyncTools(core) {
  const assetsDir = join(core.paths.selfPackageDir, 'assets', 'dsh-sync');

  function copyAsset(name, target, executable) {
    const content = core.readText(join(assetsDir, name));
    if (content == null) return false;
    const current = core.readText(target);
    if (current != null) core.writeText(`${target}.pre-maintenance.bak`, current);
    core.writeText(target, content);
    if (executable) {
      try {
        chmodSync(target, 0o755);
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  function ensure() {
    const updated = [];
    const warnings = [];
    // Windows 上插件使用纯 Node 原生引擎，不再需要 bash 工具脚本
    if (IS_WINDOWS) return { updated, warnings, skipped: true };
    core.ensureDir(core.paths.syncDir);
    for (const tool of TOOLS) {
      const target = join(core.paths.syncDir, tool.name);
      const current = core.readText(target);
      if (current != null && versionOf(current) >= tool.version) continue;
      if (copyAsset(tool.name, target, tool.executable)) updated.push(tool.name);
      else warnings.push(`缺少内置工具 ${tool.name}`);
    }
    const configTarget = join(core.paths.syncDir, 'config.sh');
    if (!core.pathExists(configTarget)) {
      if (copyAsset('config.sh', configTarget, false)) updated.push('config.sh');
      else warnings.push('缺少内置 config.sh 模板');
    }
    if (updated.length > 0) core.log(`已更新备份工具脚本: ${updated.join(', ')}`);
    if (warnings.length > 0) core.log(`备份工具自愈有警告: ${warnings.join('；')}`, 'warn');
    return { updated, warnings };
  }

  return { ensure };
}
