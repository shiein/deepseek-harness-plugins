/**
 * 跨平台逻辑单元测试（不依赖真实 Windows）。
 *
 * 验证 Windows 相关的纯逻辑：路径包含（盘符/大小写）、PATH 拼接、tar/node 解析覆盖、
 * Documents/OneDrive 回退、mirror 的排除语义。
 *
 *   node test/windows-sim.mjs
 *
 * 真实 Windows 上的 `System32\tar.exe`、Electron Node-mode、junction、taskkill 均无法
 * 在 macOS 上执行，见 docs/TEST-REPORT.md 的「Windows 未覆盖项」。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IS_WINDOWS,
  buildChildEnv,
  defaultWorkspaceDir,
  pathInside,
  resolveNodeCommand,
  resolveTarCommand,
} from '../host/platform.js';
import { compileExcludes, mirrorDirectory } from '../host/mirror.js';

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push([name, true]);
    console.log(`  ✔ ${name}`);
  } catch (error) {
    checks.push([name, false]);
    console.log(`  ✘ ${name}\n    ${error?.message || error}`);
  }
}

console.log(`\n[1] pathInside（Windows 盘符 / 大小写 / 分隔符）`);
await check('同盘符大小写不敏感', () => {
  assert.equal(pathInside('C:\\Users\\A', 'c:\\users\\a\\Documents\\x', 'win32'), true);
  assert.equal(pathInside('C:\\Users\\A', 'C:/Users/A/Documents/x', 'win32'), true);
});
await check('父目录前缀不误判', () => {
  assert.equal(pathInside('C:\\Users\\A', 'C:\\Users\\AB\\x', 'win32'), false);
  assert.equal(pathInside('/home/a', '/home/ab/x', 'darwin'), false);
});
await check('盘符根目录', () => {
  assert.equal(pathInside('C:\\', 'C:\\Users\\x', 'win32'), true);
  assert.equal(pathInside('C:\\', 'D:\\Users\\x', 'win32'), false);
});
await check('posix 正常', () => {
  assert.equal(pathInside('/Users/a/x', '/Users/a/x/y', 'darwin'), true);
  assert.equal(pathInside('/Users/a/x', '/Users/a/x2', 'darwin'), false);
});

console.log(`\n[2] 子进程环境 / 默认路径`);
await check('Windows PATH 用分号并含 System32', () => {
  const env = buildChildEnv(
    { SystemRoot: 'C:\\Windows', PATH: 'C:\\Tools', USERPROFILE: 'C:\\Users\\tester' },
    { home: 'C:\\Users\\tester', platform: 'win32' },
  );
  assert.ok(env.PATH.includes('C:\\Windows\\System32'), 'PATH 应含 System32');
  assert.ok(env.PATH.includes(';'), 'PATH 应使用 Windows 分隔符');
  assert.equal(env.HOME, 'C:\\Users\\tester');
  assert.equal(env.USERPROFILE, 'C:\\Users\\tester');
  assert.ok(!env.PATH.includes('/opt/homebrew'), '不应混入 macOS 路径');
});
await check('POSIX 环境保持原有 PATH 追加', () => {
  const env = buildChildEnv({ PATH: '/usr/bin' }, { home: '/Users/tester' });
  assert.ok(env.PATH.includes('/opt/homebrew/bin'));
  assert.ok(env.PATH.endsWith('/usr/bin'));
});
await check('DSH_WORKSPACE_DIR 覆盖默认工作区', () => {
  const previous = process.env.DSH_WORKSPACE_DIR;
  process.env.DSH_WORKSPACE_DIR = '/tmp/custom-workspace';
  try {
    assert.equal(defaultWorkspaceDir('/Users/tester'), '/tmp/custom-workspace');
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKSPACE_DIR;
    else process.env.DSH_WORKSPACE_DIR = previous;
  }
});

console.log(`\n[3] Node / tar 解析`);
await check('DSH_DESKTOP_NODE_EXECUTABLE 优先', () => {
  const result = resolveNodeCommand({
    DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
    PATH: process.env.PATH,
  });
  assert.equal(result.source, 'env-node');
  assert.equal(result.env.ELECTRON_RUN_AS_NODE, '1');
});
await check('没有 PATH node 时回退 Electron Node-mode', () => {
  const originalVersions = process.versions.electron;
  Object.defineProperty(process.versions, 'electron', { value: '40.0.0', configurable: true });
  try {
    const result = resolveNodeCommand({ PATH: '/nonexistent-dir' });
    assert.equal(result.source, 'electron-node-mode');
    assert.equal(result.command, process.execPath);
  } finally {
    if (originalVersions === undefined) delete process.versions.electron;
    else Object.defineProperty(process.versions, 'electron', { value: originalVersions, configurable: true });
  }
});
await check('DSH_MAINTENANCE_TAR 覆盖', () => {
  assert.equal(resolveTarCommand({ DSH_MAINTENANCE_TAR: '/tmp/fake-tar' }), '/tmp/fake-tar');
});

console.log(`\n[4] mirror 排除语义（Windows 下同样使用纯 Node 实现）`);
await check('compileExcludes 支持名字/后缀/相对路径子树', () => {
  const isExcluded = compileExcludes(['node_modules', '*.log', 'quarkclouddrive/deepseek', '*/sessions']);
  assert.equal(isExcluded('dsh-home/plugins/node_modules/x.js'), true);
  assert.equal(isExcluded('dsh-sync/logs/a.log'), true);
  assert.equal(isExcluded('quarkclouddrive/deepseek/task.json'), true);
  assert.equal(isExcluded('desktop/sessions/s.jsonl'), true);
  assert.equal(isExcluded('dsh-home/profiles/desktop/cordis.patch.yml'), false);
  assert.equal(isExcluded('dsh-home/profiles/desktop/cordis.patch.yml'), false);
});
await check('mirror 保留受保护子树且删除多余文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win-sim-'));
  try {
    const source = join(root, 'source');
    const target = join(root, 'target');
    mkdirSync(join(source, 'profiles', 'desktop'), { recursive: true });
    writeFileSync(join(source, 'profiles', 'desktop', 'keep.txt'), 'new');
    mkdirSync(join(target, 'profiles', 'desktop', 'sessions'), { recursive: true });
    writeFileSync(join(target, 'profiles', 'desktop', 'sessions', 'keep.jsonl'), 'session');
    writeFileSync(join(target, 'profiles', 'desktop', 'old.txt'), 'old');
    writeFileSync(join(target, 'profiles', 'desktop', 'keep.txt'), 'old');
    const result = await mirrorDirectory({
      source: join(source, 'profiles'),
      target: join(target, 'profiles'),
      excludes: ['node_modules', '*/sessions'],
    });
    assert.equal(result.files, 1);
    assert.equal(result.removed, 1);
    assert.equal(readFileSync(join(target, 'profiles', 'desktop', 'keep.txt'), 'utf8'), 'new');
    assert.ok(!existsSync(join(target, 'profiles', 'desktop', 'old.txt')));
    assert.ok(existsSync(join(target, 'profiles', 'desktop', 'sessions', 'keep.jsonl')), 'sessions 应保留');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n平台: ${IS_WINDOWS ? 'Windows' : process.platform}；Windows 专属运行路径（tar.exe/Node-mode/junction/taskkill）需在真实 Windows 上验证。`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} —— ${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
