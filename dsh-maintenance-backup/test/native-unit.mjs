#!/usr/bin/env node
/**
 * host/native/* 自测（完全离线，fake quark / fake 云端）。
 *
 * 覆盖：
 *   1. config.sh 解析（真实 ~/.dsh-sync/config.sh 拷进沙箱）
 *   2. config.json 优先 / 非法时回退 defaults / keep 覆盖与夹取
 *   3. defaults + profile link:/file: 自动发现（父目录已覆盖去重）
 *   4. scope 统计（node_modules/.git/.log 排除、pruneAbs、不可读目录 warning、禁用条目）
 *   5. sidecar/MANIFEST/RESTORE 单元 + 完整备份（tar+sidecar 上传、解压校验、sha256、指纹）
 *   6. 指纹跳过 / 改动后重新上传
 *   7. 密钥扫描（非测试路径命中 → 抛错且不生成/上传快照）
 *   8. rotation（保留 5 份、最旧 tar+sidecar 归档、孤儿 sidecar 不误删）
 *   9. AbortSignal 取消（抛错、清理 stage、不上传）
 *  10. Windows 模拟（platform/home/dshHome/workspace 注入，不崩且路径语义正确）
 *
 * 沙箱：/tmp/dsh-native-unit-<pid>/。环境变量在 createCore 之前设置。
 * 运行：node test/native-unit.mjs（DSH_NATIVE_TEST_KEEP=1 保留沙箱）
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { createCore } from '../host/core.js';
import { resolveTarCommand } from '../host/platform.js';
import { loadNativeConfig } from '../host/native/config.js';
import { buildScopeReport } from '../host/native/scope.js';
import { runNativeBackup } from '../host/native/backup.js';
import { buildStagedFileList, buildSidecar, writeManifestAndRestore } from '../host/native/sidecar.js';
import { planRotation } from '../host/native/rotation.js';
import { scanSecrets } from '../host/native/secret-scan.js';

// ---------------------------------------------------------------- 沙箱路径

const REAL_CONFIG_SH = join(homedir(), '.dsh-sync', 'config.sh');

// resolve() 让沙箱根在 Windows 上带盘符（与真实 HOME 同为绝对路径）；POSIX 上行为不变。
const sandbox = resolve('/tmp', `dsh-native-unit-${process.pid}`);
const HOME = join(sandbox, 'home');
const DSH_HOME = join(HOME, '.dsh');
const WORKSPACE = join(HOME, 'Documents', 'workspace');
const SYNC_DIR = join(HOME, '.dsh-sync');
const DATA_DIR = join(sandbox, 'data');
const CLOUD_DIR = join(sandbox, 'cloud');
const EXTRACT_DIR = join(sandbox, 'extract');

const DEFAULT_DSH_FID = '210e76226f274d749cfc712725c72c68';
const DEFAULT_ARCHIVE_FID = 'e3462aa31eb849dca82a96d8153dc41e';
const EXPECTED_DESTS = [
  'dsh-home/profiles',
  'dsh-home/skills',
  'dsh-home/agent-assets',
  'dsh-home/plugins',
  'dsh-home/.agent-presets',
  'dsh-home/llm-deepseek',
  'dsh-home/dsh-claude-style',
  'workspace/plugins',
  'workspace/dsh-page-preview',
  'workspace/dsh-agent-usage',
  'dsh-sync',
];
const EXPECTED_EXCLUDES = ['node_modules', '.git', '.DS_Store', '.turbo', '*.log', '*.tmp'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const listStageRoot = () => {
  try {
    return readdirSync(join(DATA_DIR, 'stage'));
  } catch {
    return [];
  }
};

/** 写沙箱文件（自动建父目录），content 可为 Buffer。 */
function write(abs, content) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// ---------------------------------------------------------------- 断言计数

let checkCount = 0;
/** @type {Array<{name:string,ok:boolean}>} */
const checks = [];

/** @param {string} name @param {() => Promise<void>|void} fn */
async function step(name, fn) {
  checkCount += 1;
  process.stdout.write(`\n[${checkCount}] ${name}\n`);
  try {
    await fn();
    checks.push({ name, ok: true });
    process.stdout.write(`  ✓ PASS\n`);
  } catch (error) {
    checks.push({ name, ok: false });
    process.stdout.write(`  ✗ FAIL\n`);
    throw error;
  }
}

// ---------------------------------------------------------------- 沙箱内容

function buildSandbox() {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(CLOUD_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(SYNC_DIR, { recursive: true });
  mkdirSync(join(DSH_HOME, 'profiles', 'desktop'), { recursive: true });

  write(join(DSH_HOME, 'plugins', 'p1', 'index.js'), 'export const p1 = 1;\n');
  write(join(DSH_HOME, 'plugins', 'p1', 'README.md'), '# p1\n');
  write(join(DSH_HOME, 'skills', 'quarkclouddrive', 'SKILL.md'), '# quark skill\n');
  write(join(DSH_HOME, 'skills', 'quarkclouddrive', 'deepseek', 'task.json'), '{"task":1}\n');
  write(join(DSH_HOME, 'skills', 'quarkclouddrive', 'browse', 'cache.json'), '{"cache":1}\n');
  write(join(DSH_HOME, 'agent-assets', 'asset.txt'), 'asset\n');
  write(join(DSH_HOME, '.agent-presets', 'preset.json'), '{"preset":1}\n');
  write(join(DSH_HOME, 'llm-deepseek', 'config.json'), '{"model":"x"}\n');
  write(join(DSH_HOME, 'dsh-claude-style', 'style.md'), '# style\n');
  write(join(DSH_HOME, 'plugins', '.DS_Store'), 'junk');

  write(join(WORKSPACE, 'dsh', 'plugins', 'plugin-a', 'index.js'), 'plugin-a\n');
  // 512KB 随机内容：保证快照大小可测，且被密钥扫描识别为二进制跳过
  write(join(WORKSPACE, 'dsh', 'plugins', 'plugin-a', 'big.bin'), randomBytes(512 * 1024));
  write(join(WORKSPACE, 'dsh-page-preview', 'src', 'app.js'), 'page-preview\n');
  write(join(WORKSPACE, 'overview', 'dsh-agent-usage', 'run.js'), 'usage\n');
}

// ---------------------------------------------------------------- fake 夸克

function createFakeQuark() {
  /** @type {Map<string, {fid:string, filename:string, parentFid:string, path:string, size:number, createdAt:number}>} */
  const files = new Map();
  const uploads = [];
  const moves = [];
  let browseCalls = 0;
  const fakeQuark = {
    async upload(file, parentFid) {
      const filename = String(file).split(sep).pop();
      const fid = `fid-${filename}`;
      const target = join(CLOUD_DIR, filename);
      copyFileSync(file, target);
      files.set(fid, { fid, filename, parentFid, path: target, size: statSync(target).size, createdAt: Date.now() });
      uploads.push({ file, parentFid, fid });
      return { ok: true, fid, data: { fids: [fid] }, code: 0, msg: '成功' };
    },
    async browseAll(parentFid) {
      browseCalls += 1;
      const entries = [...files.values()]
        .filter((item) => item.parentFid === parentFid)
        .map((item) => ({
          fid: item.fid,
          filename: item.filename,
          size: item.size,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          fileType: 'file',
        }));
      return { ok: true, entries, filePath: null, code: 0, msg: '成功' };
    },
    async move(fids, targetFid) {
      moves.push({ fids: [...fids], targetFid });
      for (const fid of fids) {
        const item = files.get(fid);
        if (item) item.parentFid = targetFid;
      }
      return { ok: true, data: { fids, targetFid }, code: 0, msg: '成功' };
    },
  };
  const cloudFiles = () => [...files.values()];
  return { fakeQuark, cloudFiles, uploads, moves, getBrowseCalls: () => browseCalls };
}

// ---------------------------------------------------------------- Windows 模拟

const WIN = {
  platform: 'win32',
  home: 'C:\\Users\\tester',
  dshHome: 'C:\\Users\\tester\\.dsh',
  workspace: 'C:\\Users\\tester\\Documents\\workspace',
};

// ---------------------------------------------------------------- 主流程

async function main() {
  buildSandbox();

  // 环境必须在 createCore 之前设置（createCore 读取 env）
  process.env.HOME = HOME;
  // Windows 上 os.homedir() 读 USERPROFILE 而不是 HOME，沙箱 home 必须两个都设
  if (process.platform === 'win32') process.env.USERPROFILE = HOME;
  process.env.DSH_HOME = DSH_HOME;
  process.env.DSH_WORKSPACE_DIR = WORKSPACE;
  process.env.DSH_SYNC_DIR = SYNC_DIR;
  process.env.DSH_MAINTENANCE_DIR = DATA_DIR;
  delete process.env.DSH_SYNC_DSH_FID;
  delete process.env.DSH_SYNC_ARCHIVE_FID;
  delete process.env.DSH_MAINTENANCE_KEEP_STAGE;
  delete process.env.DSH_MAINTENANCE_TAR;

  /** @type {Array<[string,string]>} */
  const logLines = [];
  const logger = {
    info: (message) => logLines.push(['info', String(message)]),
    warn: (message) => logLines.push(['warn', String(message)]),
    error: (message) => logLines.push(['error', String(message)]),
  };
  const core = createCore({ logger });
  const fake = createFakeQuark();
  const quark = fake.fakeQuark;

  assert.equal(core.paths.home, HOME, 'core.paths.home 应指向沙箱 HOME');
  assert.equal(core.paths.dshHome, DSH_HOME);
  assert.equal(core.paths.syncDir, SYNC_DIR);
  assert.equal(core.paths.dataDir, DATA_DIR);

  // ---------------------------------------------------------------- [1]
  await step('config.sh 解析（真实配置：11 条目 / FID / KEEP / PRUNE_ABS / EXCLUDES）', async () => {
    rmSync(join(SYNC_DIR, 'config.json'), { force: true });
    copyFileSync(REAL_CONFIG_SH, join(SYNC_DIR, 'config.sh'));
    const config = await loadNativeConfig(core);
    assert.equal(config.source, 'config.sh');
    assert.equal(config.entries.length, 11);
    assert.deepEqual(config.entries.map((entry) => entry.dest), EXPECTED_DESTS);
    assert.deepEqual(
      config.entries.map((entry) => entry.src),
      [
        join(DSH_HOME, 'profiles'),
        join(DSH_HOME, 'skills'),
        join(DSH_HOME, 'agent-assets'),
        join(DSH_HOME, 'plugins'),
        join(DSH_HOME, '.agent-presets'),
        join(DSH_HOME, 'llm-deepseek'),
        join(DSH_HOME, 'dsh-claude-style'),
        join(WORKSPACE, 'dsh', 'plugins'),
        join(WORKSPACE, 'dsh-page-preview'),
        join(WORKSPACE, 'overview', 'dsh-agent-usage'),
        SYNC_DIR,
      ],
    );
    assert.equal(config.dshFid, DEFAULT_DSH_FID);
    assert.equal(config.archiveFid, DEFAULT_ARCHIVE_FID);
    assert.equal(config.keep, 5);
    assert.deepEqual(config.pruneAbs, [
      join(DSH_HOME, 'skills', 'quarkclouddrive', 'deepseek'),
      join(DSH_HOME, 'skills', 'quarkclouddrive', 'browse'),
      join(SYNC_DIR, 'state'),
      join(SYNC_DIR, 'logs'),
    ]);
    assert.deepEqual(config.excludes, EXPECTED_EXCLUDES);
    assert.deepEqual(config.disabledEntries, []);
    assert.equal(config.entries.filter((entry) => entry.discovered).length, 0);
  });

  // ---------------------------------------------------------------- [2]
  await step('config.json 优先 / 非法时回退 defaults / keep 覆盖与夹取', async () => {
    const configJsonFile = join(SYNC_DIR, 'config.json');
    write(
      configJsonFile,
      JSON.stringify({
        dshFid: 'fid-json',
        archiveFid: 'fid-archive-json',
        keep: 3,
        entries: [{ src: join(DSH_HOME, 'plugins'), dest: 'dsh-home/plugins' }],
        pruneAbs: [join(SYNC_DIR, 'state')],
        excludes: ['node_modules'],
      }),
    );
    const jsonConfig = await loadNativeConfig(core);
    assert.equal(jsonConfig.source, 'config.json');
    assert.equal(jsonConfig.dshFid, 'fid-json');
    assert.equal(jsonConfig.archiveFid, 'fid-archive-json');
    assert.equal(jsonConfig.keep, 3);
    assert.equal(jsonConfig.entries.length, 1);
    assert.equal(jsonConfig.entries[0].src, join(DSH_HOME, 'plugins'));
    assert.equal(jsonConfig.entries[0].dest, 'dsh-home/plugins');
    // pruneAbs = 默认 4 项 + 配置项（去重后仍是 4 项）
    assert.equal(jsonConfig.pruneAbs.length, 4);
    assert.ok(jsonConfig.pruneAbs.includes(join(DSH_HOME, 'skills', 'quarkclouddrive', 'deepseek')));
    assert.ok(jsonConfig.pruneAbs.includes(join(DSH_HOME, 'skills', 'quarkclouddrive', 'browse')));
    assert.ok(jsonConfig.pruneAbs.includes(join(SYNC_DIR, 'state')));
    assert.ok(jsonConfig.pruneAbs.includes(join(SYNC_DIR, 'logs')));
    assert.deepEqual(jsonConfig.excludes, ['node_modules']);

    // 额外的自定义 prune 会追加在默认项之后
    write(
      configJsonFile,
      JSON.stringify({
        dshFid: 'fid-json',
        archiveFid: 'fid-archive-json',
        keep: 3,
        entries: [{ src: join(DSH_HOME, 'plugins'), dest: 'dsh-home/plugins' }],
        pruneAbs: [join(SYNC_DIR, 'state'), join(HOME, 'extra-state')],
        excludes: ['node_modules'],
      }),
    );
    const extraPrune = await loadNativeConfig(core);
    assert.equal(extraPrune.pruneAbs.length, 5);
    assert.equal(extraPrune.pruneAbs.at(-1), join(HOME, 'extra-state'));

    // 非法 JSON：即使 config.sh 存在也回退 defaults（并写 warning）
    write(configJsonFile, '{ "entries": [ oops');
    logLines.length = 0;
    const fallback = await loadNativeConfig(core);
    assert.equal(fallback.source, 'defaults');
    assert.equal(fallback.entries.length, 11);
    assert.deepEqual(fallback.entries.map((entry) => entry.dest), EXPECTED_DESTS);
    assert.ok(
      logLines.some(([level, message]) => level === 'warn' && message.includes('回退内置默认配置')),
      '解析失败应写 warning 日志',
    );

    // options.keep 优先，并限制在 1..10
    assert.equal((await loadNativeConfig(core, { keep: 7 })).keep, 7);
    assert.equal((await loadNativeConfig(core, { keep: 99 })).keep, 10);
    assert.equal((await loadNativeConfig(core, { keep: 0 })).keep, 1);

    rmSync(configJsonFile, { force: true });
    rmSync(join(SYNC_DIR, 'config.sh'), { force: true });
  });

  // ---------------------------------------------------------------- [3]
  await step('defaults + link:/file: 自动发现（父目录已覆盖去重、disabledEntries）', async () => {
    write(join(WORKSPACE, 'standalone-plugin', 'index.js'), 'standalone\n');
    write(join(WORKSPACE, 'file-dep', 'package.json'), '{"name":"file-dep"}\n');
    write(join(WORKSPACE, 'dsh', 'plugins', 'covered-plugin', 'index.js'), 'covered\n');
    write(
      join(DSH_HOME, 'profiles', 'desktop', 'package.json'),
      JSON.stringify({
        name: 'desktop',
        dependencies: { 'standalone-plugin': `link:${join(WORKSPACE, 'standalone-plugin')}` },
        devDependencies: { 'file-dep': `file:${join(WORKSPACE, 'file-dep')}` },
        optionalDependencies: { 'covered-plugin': `link:${join(WORKSPACE, 'dsh', 'plugins', 'covered-plugin')}` },
      }),
    );

    const config = await loadNativeConfig(core);
    assert.equal(config.source, 'defaults');
    assert.equal(config.entries.length, 13, '11 个默认 + 2 个自动发现');
    const discovered = config.entries.filter((entry) => entry.discovered);
    assert.equal(discovered.length, 2);
    const standalone = config.entries.find((entry) => entry.src === join(WORKSPACE, 'standalone-plugin'));
    assert.ok(standalone, '应发现 link: 插件');
    assert.equal(standalone.dest, 'workspace/standalone-plugin');
    assert.equal(standalone.discovered, true);
    const fileDep = config.entries.find((entry) => entry.src === join(WORKSPACE, 'file-dep'));
    assert.ok(fileDep, '应发现 file: 依赖');
    assert.equal(fileDep.dest, 'workspace/file-dep');
    assert.ok(
      !config.entries.some((entry) => entry.src === join(WORKSPACE, 'dsh', 'plugins', 'covered-plugin')),
      '父目录（workspace/plugins）已覆盖的条目应去重',
    );

    core.updateState({ disabledEntries: [join(DSH_HOME, 'agent-assets')] });
    const withDisabled = await loadNativeConfig(core);
    assert.deepEqual(withDisabled.disabledEntries, [join(DSH_HOME, 'agent-assets')]);
    core.updateState({ disabledEntries: [] });
  });

  // ---------------------------------------------------------------- [4]
  await step('scope 统计（排除 node_modules/.git/*.log、pruneAbs、不可读目录 warning）', async () => {
    const config = await loadNativeConfig(core);
    const before = await buildScopeReport({ core, config, keep: config.keep });
    assert.equal(before.ok, true);
    assert.equal(before.source, 'defaults');
    assert.equal(before.keep, 5);
    assert.equal(before.dshFid, DEFAULT_DSH_FID);
    assert.equal(before.archiveFid, DEFAULT_ARCHIVE_FID);
    assert.equal(before.entries.length, config.entries.length);
    assert.ok(before.totals.files > 0, '应有文件被统计');
    assert.ok(before.totals.bytes > 0);
    assert.ok(before.totals.enabledEntries > 0);
    for (const entry of before.entries) {
      assert.equal(typeof entry.src, 'string');
      assert.equal(typeof entry.dest, 'string');
      assert.equal(typeof entry.label, 'string');
      assert.equal(typeof entry.exists, 'boolean');
      assert.equal(typeof entry.readable, 'boolean');
      assert.equal(typeof entry.files, 'number');
      assert.equal(typeof entry.bytes, 'number');
      assert.equal(typeof entry.discovered, 'boolean');
      assert.equal(typeof entry.disabled, 'boolean');
    }
    assert.ok(before.excluded.some((item) => item.path.endsWith('.credentials.yaml')));

    const pluginsEntry = before.entries.find((entry) => entry.src === join(DSH_HOME, 'plugins'));
    assert.ok(pluginsEntry);
    assert.ok(pluginsEntry.exists && pluginsEntry.readable);
    assert.ok(pluginsEntry.files >= 2);

    // pruneAbs：技能目录下的 deepseek/browse 不计入
    const skillsEntry = before.entries.find((entry) => entry.src === join(DSH_HOME, 'skills'));
    assert.ok(skillsEntry);
    assert.equal(skillsEntry.files, 1, 'deepseek/browse 应被 pruneAbs 排除，只剩 SKILL.md');

    // node_modules/.git/*.log 等不改变统计
    write(join(DSH_HOME, 'plugins', 'node_modules', 'junk.js'), 'x'.repeat(4096));
    write(join(DSH_HOME, 'plugins', '.git', 'config'), 'git');
    write(join(DSH_HOME, 'plugins', 'debug.log'), 'log line');
    write(join(DSH_HOME, 'plugins', 'cache.tmp'), 'tmp');
    const after = await buildScopeReport({ core, config, keep: config.keep });
    const pluginsAfter = after.entries.find((entry) => entry.src === join(DSH_HOME, 'plugins'));
    assert.equal(pluginsAfter.files, pluginsEntry.files, 'node_modules/.git 应被排除，不改变文件数');
    assert.equal(pluginsAfter.bytes, pluginsEntry.bytes);

    // 不可读子目录 → readable 仍为 true，但 warning 标注读取失败
    // Windows 的 NTFS ACL 不认 POSIX mode bits，chmod 0o000 后目录依然可读，跳过该断言
    if (process.platform !== 'win32') {
      const unreadable = join(DSH_HOME, 'plugins', 'unreadable');
      write(join(unreadable, 'x.txt'), 'x');
      chmodSync(unreadable, 0o000);
      try {
        const third = await buildScopeReport({ core, config, keep: config.keep });
        const pluginsThird = third.entries.find((entry) => entry.src === join(DSH_HOME, 'plugins'));
        assert.ok(pluginsThird.warning, '不可读子目录应产生 warning');
        assert.match(pluginsThird.warning, /子目录读取失败/);
        assert.equal(pluginsThird.files, pluginsEntry.files);
      } finally {
        chmodSync(unreadable, 0o755);
      }
    }

    // 禁用条目不计入 totals
    core.updateState({ disabledEntries: [join(DSH_HOME, 'plugins')] });
    const disabledConfig = await loadNativeConfig(core);
    const disabledReport = await buildScopeReport({ core, config: disabledConfig, keep: 5 });
    const disabledEntry = disabledReport.entries.find((entry) => entry.src === join(DSH_HOME, 'plugins'));
    assert.equal(disabledEntry.disabled, true);
    assert.equal(disabledReport.totals.files, before.totals.files - pluginsEntry.files);
    assert.equal(disabledReport.totals.enabledEntries, before.totals.enabledEntries - 1);
    core.updateState({ disabledEntries: [] });
  });

  // ---------------------------------------------------------------- [5]
  let firstBackup = null;
  let firstFingerprintHash = null;
  await step('sidecar/MANIFEST/RESTORE + 完整备份（上传 tar+sidecar、解压校验、指纹）', async () => {
    // ---- sidecar / MANIFEST 单元（独立 stage 探针）
    const probe = join(sandbox, 'stage-probe');
    write(join(probe, 'dsh-home', 'a.txt'), 'hello');
    write(join(probe, 'workspace', 'p', 'b.txt'), 'world!!');
    write(join(probe, 'dsh-sync', 'conf.sh'), 'x');
    write(join(probe, 'MANIFEST.json'), '{}');
    write(join(probe, 'RESTORE.md'), '#');
    const files = buildStagedFileList(probe);
    assert.deepEqual(files.map((item) => item[0]), ['dsh-home/a.txt', 'dsh-sync/conf.sh', 'workspace/p/b.txt']);
    assert.deepEqual(files.map((item) => item[1]), [5, 1, 7]);
    const probeName = 'dsh-snap-2026-01-01_000000.tar.gz';
    const written = writeManifestAndRestore(probe, {
      snapshotName: probeName,
      files,
      entries: [{ dest: 'dsh-home', files: 1, bytes: 5 }],
      platform: 'darwin',
      engine: 'native',
      partial: false,
    });
    const manifestProbe = readJson(written.manifestPath);
    assert.equal(manifestProbe.name, probeName);
    assert.equal(manifestProbe.file_count, 3);
    assert.equal(manifestProbe.partial, false);
    assert.equal(manifestProbe.approx_size_mb, 0);
    assert.equal(typeof manifestProbe.hostname, 'string');
    assert.ok(existsSync(written.restorePath));
    assert.match(readFileSync(written.restorePath, 'utf8'), /恢复说明/);

    const fakeArchive = write(join(sandbox, 'archives', 'probe.tar.gz'), Buffer.from('not-a-real-tar'));
    const fakeSha = sha256File(fakeArchive);
    const sidecarProbe = buildSidecar({
      snapshotName: probeName,
      archivePath: fakeArchive,
      archiveSha256: fakeSha,
      files,
      partial: false,
      createdAt: Date.now(),
    });
    assert.equal(sidecarProbe.schema, 1);
    assert.equal(sidecarProbe.file_count, 3);
    assert.equal(sidecarProbe.total_bytes, 13);
    assert.equal(sidecarProbe.archive_sha256, fakeSha);
    assert.equal(sidecarProbe.archive_size, statSync(fakeArchive).size);
    assert.equal(typeof sidecarProbe.created_at, 'string');
    assert.deepEqual(sidecarProbe.entries.map((item) => item.dest), ['dsh-home/a.txt', 'dsh-sync', 'workspace/p']);

    // ---- 完整备份
    const config = await loadNativeConfig(core);
    const uploadsBefore = fake.uploads.length;
    /** @type {Array<{stage:string,label?:string,progress?:number,line?:string}>} */
    const events = [];
    const result = await runNativeBackup({
      core,
      quark,
      config,
      keep: 5,
      force: true,
      trigger: 'test',
      onEvent: (event) => events.push(event),
    });
    firstBackup = result;
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.match(result.snapshotName, /^dsh-snap-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/);
    assert.equal(result.partial, false);
    assert.ok(result.sizeMB > 0.1, `sizeMB 应大于 0.1，实际 ${result.sizeMB}`);
    assert.ok(result.fileCount > 10);
    assert.ok(result.totalBytes > 1024);
    assert.equal(result.archived, 0);
    assert.equal(result.sidecarName, `${result.snapshotName.replace(/\.tar\.gz$/, '')}.manifest.json`);
    assert.ok(result.durationMs >= 0);
    assert.ok(Array.isArray(result.warnings));
    assert.equal(fake.uploads.length, uploadsBefore + 2, '应上传 tar + sidecar');

    const stages = new Set(events.map((event) => event.stage));
    for (const stage of ['prepare', 'pack', 'scan', 'upload', 'archive', 'done']) {
      assert.ok(stages.has(stage), `事件应包含阶段 ${stage}`);
    }
    assert.equal(events.at(-1).stage, 'done');
    assert.equal(events.at(-1).progress, 100);
    assert.ok(events.some((event) => event.line && event.line.includes('敏感信息扫描通过')));
    assert.ok(events.every((event) => typeof event.stage === 'string'));

    // ---- 云端 tar + sidecar
    const tarEntry = fake.cloudFiles().find((item) => item.filename === result.snapshotName);
    assert.ok(tarEntry, '云端应出现 tar');
    const sidecarEntry = fake.cloudFiles().find((item) => item.filename === result.sidecarName);
    assert.ok(sidecarEntry, '云端应出现 sidecar');

    // ---- 解压校验
    rmSync(EXTRACT_DIR, { recursive: true, force: true });
    mkdirSync(EXTRACT_DIR, { recursive: true });
    execFileSync(resolveTarCommand(), ['-xzf', tarEntry.path, '-C', EXTRACT_DIR], { stdio: 'pipe' });
    assert.ok(existsSync(join(EXTRACT_DIR, 'dsh-home', 'plugins', 'p1', 'index.js')), '快照应包含 dsh-home 文件');
    assert.ok(existsSync(join(EXTRACT_DIR, 'workspace', 'plugins', 'plugin-a', 'index.js')), '快照应包含 workspace 文件');
    assert.ok(!existsSync(join(EXTRACT_DIR, 'dsh-home', 'plugins', 'node_modules')), 'node_modules 不应进入快照');
    assert.ok(!existsSync(join(EXTRACT_DIR, 'dsh-home', 'plugins', '.git')), '.git 不应进入快照');
    const extractedManifest = readJson(join(EXTRACT_DIR, 'MANIFEST.json'));
    assert.equal(extractedManifest.name, result.snapshotName);
    assert.equal(extractedManifest.file_count, result.fileCount);
    assert.equal(extractedManifest.partial, false);
    assert.equal(typeof extractedManifest.hostname, 'string');
    assert.equal(typeof extractedManifest.approx_size_mb, 'number');

    // ---- sidecar 内容（make-sidecar.cjs 兼容）
    const sidecarJson = readJson(sidecarEntry.path);
    assert.equal(sidecarJson.schema, 1);
    assert.equal(sidecarJson.name, result.snapshotName);
    assert.equal(sidecarJson.archive_sha256, sha256File(tarEntry.path));
    assert.equal(sidecarJson.archive_size, statSync(tarEntry.path).size);
    assert.equal(sidecarJson.file_count, result.fileCount);
    assert.equal(sidecarJson.files.length, result.fileCount);
    assert.equal(sidecarJson.total_bytes, result.totalBytes);
    assert.equal(sidecarJson.files.reduce((sum, [, size]) => sum + size, 0), result.totalBytes);
    assert.equal(sidecarJson.partial, false);
    assert.ok(Array.isArray(sidecarJson.entries) && sidecarJson.entries.length > 0);
    for (const [filePath] of sidecarJson.files) {
      assert.match(filePath, /^(dsh-home|workspace|dsh-sync)\//, `包内路径应为 posix：${filePath}`);
      assert.ok(!filePath.includes('\\'), `包内路径不应包含反斜杠：${filePath}`);
      assert.notEqual(filePath, 'MANIFEST.json');
      assert.notEqual(filePath, 'RESTORE.md');
    }

    // ---- 指纹
    const fingerprint = readJson(join(DATA_DIR, 'state', 'native-fingerprint.json'));
    firstFingerprintHash = fingerprint.hash;
    assert.match(fingerprint.hash, /^[0-9a-f]{64}$/);
    assert.equal(fingerprint.files, result.fileCount);
    assert.equal(fingerprint.bytes, result.totalBytes);
    assert.equal(fingerprint.trigger, 'test');
    assert.equal(fingerprint.platform, process.platform);
    assert.ok(fingerprint.at > 0);

    // ---- 临时文件清理
    assert.deepEqual(listStageRoot(), [], '备份完成后不应残留 stage/tar/sidecar');
  });

  // ---------------------------------------------------------------- [6]
  await step('指纹跳过：第二次无变更 skipped 且不上传；改动后再上传', async () => {
    const config = await loadNativeConfig(core);
    const uploadsBefore = fake.uploads.length;
    const skipEvents = [];
    const skipped = await runNativeBackup({
      core,
      quark,
      config,
      keep: 5,
      force: false,
      onEvent: (event) => skipEvents.push(event),
    });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.snapshotName, null);
    assert.equal(skipped.sizeMB, 0);
    assert.equal(skipped.archived, 0);
    assert.equal(fake.uploads.length, uploadsBefore, '无变更不应触碰网盘');
    assert.equal(fake.getBrowseCalls(), 1, '无变更不应浏览网盘');
    assert.ok(skipEvents.some((event) => event.stage === 'skip'));
    assert.match(skipEvents.find((event) => event.stage === 'skip').line, /无变更/);

    // 改动一个文件 → 下一次自动模式应重新上传（加 sleep 避免同一秒快照重名）
    writeFileSync(join(WORKSPACE, 'dsh', 'plugins', 'plugin-a', 'index.js'), 'plugin-a changed\n');
    await sleep(1100);
    const changed = await runNativeBackup({ core, quark, config, keep: 5, force: false, trigger: 'auto' });
    assert.equal(changed.ok, true);
    assert.equal(changed.skipped, false);
    assert.notEqual(changed.snapshotName, firstBackup.snapshotName);
    assert.equal(fake.uploads.length, uploadsBefore + 2);
    const fingerprint = readJson(join(DATA_DIR, 'state', 'native-fingerprint.json'));
    assert.notEqual(fingerprint.hash, firstFingerprintHash);
    assert.equal(fingerprint.files, changed.fileCount);
    assert.equal(fingerprint.trigger, 'auto');
    assert.equal(changed.archived, 0, '快照数未超过 keep，不应归档');
    assert.equal(fake.moves.length, 0);
  });

  // ---------------------------------------------------------------- [7]
  await step('密钥扫描：非测试路径命中即失败，且不生成/上传快照', async () => {
    // 直接单测 scanSecrets：hits / testHits / 二进制跳过
    const scanDir = join(sandbox, 'scan-probe');
    write(join(scanDir, 'dsh-home', 'plugins', 'leak.txt'), `token = "sk-${'A1b2C3d4E5f6G7h8I9j0K1l2'}"\n`);
    write(join(scanDir, 'dsh-home', 'plugins', 'tests', 'fake.js'), `const k = "sk-${'Z'.repeat(24)}";\n`);
    write(join(scanDir, 'dsh-home', 'plugins', 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
    const scan = scanSecrets(scanDir);
    assert.deepEqual(scan.hits, ['dsh-home/plugins/leak.txt']);
    assert.deepEqual(scan.testHits, ['dsh-home/plugins/tests/fake.js']);
    assert.ok(scan.scanned >= 2);

    // 真实备份里出现密钥 → 抛错
    const secretValue = `sk-${'Q'.repeat(30)}`;
    const secretFile = write(join(DSH_HOME, 'plugins', 'secret-leak.txt'), `api_key = ${secretValue}\n`);
    const config = await loadNativeConfig(core);
    const uploadsBefore = fake.uploads.length;
    const tarCountBefore = fake.cloudFiles().filter((item) => item.filename.endsWith('.tar.gz')).length;
    let error = null;
    try {
      await runNativeBackup({ core, quark, config, keep: 5, force: true, trigger: 'test' });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, '密钥命中应抛错');
    assert.match(error.message, /敏感信息扫描未通过/);
    assert.ok(!error.message.includes(secretValue), '错误消息不能回显密钥原文');
    assert.ok(!error.message.includes('Q'.repeat(30)), '错误消息不能包含密钥片段');
    assert.equal(fake.uploads.length, uploadsBefore, '命中后不应上传任何对象');
    assert.equal(fake.cloudFiles().filter((item) => item.filename.endsWith('.tar.gz')).length, tarCountBefore);
    assert.deepEqual(listStageRoot(), [], '失败后应清理 stage/tar');
    rmSync(secretFile, { force: true });
  });

  // ---------------------------------------------------------------- [8]
  await step('rotation：保留 5 份、归档最旧 tar + 对应 sidecar、孤儿清单不误删', async () => {
    const stamps = [
      '2026-11-01_010101',
      '2026-11-02_010101',
      '2026-11-03_010101',
      '2026-11-04_010101',
      '2026-11-05_010101',
      '2026-11-06_010101',
    ];
    /** @type {Array<{fid:string,filename:string}>} */
    const entries = [];
    stamps.forEach((stamp, index) => {
      entries.push({ fid: `tar-${index}`, filename: `dsh-snap-${stamp}.tar.gz` });
      entries.push({ fid: `side-${index}`, filename: `dsh-snap-${stamp}.manifest.json` });
    });
    const plan = planRotation(entries, 5);
    assert.deepEqual(
      plan.kept,
      stamps.slice(1).reverse().map((stamp) => `dsh-snap-${stamp}.tar.gz`),
      '应保留最新 5 份',
    );
    assert.deepEqual(plan.pruneFids, ['tar-0', 'side-0'], '最旧 tar + 对应 sidecar 一起归档');
    assert.deepEqual(plan.pruned, [
      `dsh-snap-${stamps[0]}.tar.gz`,
      `dsh-snap-${stamps[0]}.manifest.json`,
    ]);

    // 比保留边界更新的孤儿 sidecar（tar 尚未上传）不应被归档
    const orphan = planRotation(
      [...entries, { fid: 'orphan-side', filename: 'dsh-snap-2026-11-07_010101.manifest.json' }],
      5,
    );
    assert.deepEqual(orphan.pruneFids, ['tar-0', 'side-0'], '新上传的孤儿 sidecar 不能被误删');
    assert.ok(!orphan.pruneFids.includes('orphan-side'));

    // 旧快照没有 sidecar 也要归档 tar
    const noSidecar = planRotation(entries.filter((entry) => !entry.fid.startsWith('side-')), 5);
    assert.deepEqual(noSidecar.pruneFids, ['tar-0']);
    // 重复 FID / 空输入
    assert.deepEqual(planRotation([...entries, entries[0]], 5).pruneFids, ['tar-0', 'side-0']);
    assert.deepEqual(planRotation([], 5), { kept: [], pruneFids: [], pruned: [] });
    assert.deepEqual(planRotation(null, 5), { kept: [], pruneFids: [], pruned: [] });
  });

  // ---------------------------------------------------------------- [9]
  await step('取消 signal：备份中途 abort → 抛错、清理 stage、不上传', async () => {
    const config = await loadNativeConfig(core);
    const uploadsBefore = fake.uploads.length;
    const controller = new AbortController();
    let abortedOnce = false;
    /** @type {Array<{stage:string}>} */
    const events = [];
    let error = null;
    try {
      await runNativeBackup({
        core,
        quark,
        config,
        keep: 5,
        force: true,
        trigger: 'test',
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (!abortedOnce && event.stage === 'scan') {
            abortedOnce = true;
            controller.abort();
          }
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(abortedOnce, '测试应在 scan 阶段触发取消');
    assert.ok(error, '取消应抛错');
    assert.match(error.message, /已取消/);
    assert.equal(fake.uploads.length, uploadsBefore, '取消后不应上传');
    assert.deepEqual(listStageRoot(), [], '取消后应清理 stage/tar');
    assert.ok(events.some((event) => event.stage === 'error'));
  });

  // ---------------------------------------------------------------- [10]
  await step('Windows 模拟：config.sh/defaults 在 win32 路径下不崩且语义正确', async () => {
    rmSync(join(SYNC_DIR, 'config.json'), { force: true });
    rmSync(join(SYNC_DIR, 'config.sh'), { force: true });

    // (a) 与任务书一致的调用（只注入 platform/home/dshHome/workspace）→ 内置 defaults
    const winDefaults = await loadNativeConfig(core, WIN);
    assert.equal(winDefaults.source, 'defaults');
    assert.equal(winDefaults.entries.length, 11);
    assert.equal(winDefaults.entries[0].src, join(WIN.dshHome, 'profiles'));
    assert.equal(winDefaults.entries[7].src, join(WIN.workspace, 'dsh', 'plugins'));
    assert.equal(winDefaults.entries[10].src, winDefaults.paths.syncDir);
    assert.equal(winDefaults.entries[10].dest, 'dsh-sync');
    assert.equal(winDefaults.paths.syncDir, join(WIN.home, '.dsh-sync'));
    assert.equal(winDefaults.paths.dshHome, WIN.dshHome);
    assert.equal(winDefaults.paths.platform, 'win32');
    assert.equal(winDefaults.keep, 5);
    assert.deepEqual(winDefaults.excludes, EXPECTED_EXCLUDES);
    assert.equal(winDefaults.pruneAbs.length, 4);
    assert.ok(winDefaults.pruneAbs[0].startsWith(WIN.dshHome));
    assert.ok(winDefaults.pruneAbs[1].startsWith(WIN.dshHome));
    assert.ok(winDefaults.pruneAbs[2].startsWith(winDefaults.paths.syncDir));
    assert.ok(winDefaults.pruneAbs[3].startsWith(winDefaults.paths.syncDir));

    // scope 用 win32 平台 + 不存在的 Windows 路径：应正常返回（全部 exists=false），不能崩
    const winScope = await buildScopeReport({ core, config: winDefaults, keep: 5, platform: 'win32' });
    assert.equal(winScope.ok, true);
    assert.equal(winScope.entries.length, 11);
    assert.equal(winScope.totals.files, 0);
    assert.ok(winScope.entries.every((entry) => entry.exists === false));

    // (b) 真实 config.sh 的 $HOME 展开成 Windows 根目录（额外注入 syncDir 以读到配置文件）
    copyFileSync(REAL_CONFIG_SH, join(SYNC_DIR, 'config.sh'));
    const winSh = await loadNativeConfig(core, { ...WIN, syncDir: SYNC_DIR });
    assert.equal(winSh.source, 'config.sh');
    assert.equal(winSh.entries.length, 11);
    assert.deepEqual(winSh.entries.map((entry) => entry.dest), EXPECTED_DESTS);
    assert.ok(winSh.entries.every((entry) => entry.src.startsWith(WIN.home)), '条目 src 应位于模拟 HOME 下');
    assert.equal(winSh.entries[0].src, join(WIN.home, '.dsh', 'profiles'));
    assert.equal(winSh.entries[7].src, join(WIN.home, 'Documents', 'workspace', 'dsh', 'plugins'));
    assert.equal(winSh.entries[10].dest, 'dsh-sync');
    assert.equal(winSh.entries[10].src, join(WIN.home, '.dsh-sync'));
    assert.equal(winSh.keep, 5);
    assert.deepEqual(winSh.excludes, EXPECTED_EXCLUDES);
    // 默认 pruneAbs（基于注入的 syncDir）与 config.sh 的 $HOME/.dsh-sync 值都会保留
    assert.ok(winSh.pruneAbs.length >= 4);
    assert.ok(winSh.pruneAbs.every((target) => target.startsWith(WIN.home) || target.startsWith(SYNC_DIR)));
    assert.ok(winSh.pruneAbs.some((target) => target.startsWith(WIN.dshHome)));
    assert.ok(winSh.pruneAbs.some((target) => target.startsWith(join(WIN.home, '.dsh-sync'))));
    assert.ok(winSh.pruneAbs.some((target) => target.startsWith(SYNC_DIR)));
    rmSync(join(SYNC_DIR, 'config.sh'), { force: true });
  });

  // ---------------------------------------------------------------- [11]
  if (process.platform !== 'win32') {
    await step('tar 不支持 gzip 时回退 tar -cf + node:zlib 压缩', async () => {
      const realTar = resolveTarCommand();
      const fakeBin = join(sandbox, 'fakebin');
      mkdirSync(fakeBin, { recursive: true });
      const fakeTar = join(fakeBin, 'tar-no-gzip.sh');
      write(
        fakeTar,
        `#!/bin/sh\ncase "$1" in\n  -czf)\n    echo "tar: gzip compressed archives not supported" >&2\n    exit 1\n    ;;\nesac\nexec ${JSON.stringify(realTar)} "$@"\n`,
      );
      chmodSync(fakeTar, 0o755);

      const config = await loadNativeConfig(core);
      const uploadsBefore = fake.uploads.length;
      // 避免与前面的快照落在同一秒（文件名只精确到秒）
      await sleep(1100);
      const events = [];
      process.env.DSH_MAINTENANCE_TAR = fakeTar;
      let result;
      try {
        result = await runNativeBackup({
          core,
          quark,
          config,
          keep: 5,
          force: true,
          trigger: 'test',
          onEvent: (event) => events.push(event),
        });
      } finally {
        delete process.env.DSH_MAINTENANCE_TAR;
      }
      assert.equal(result.ok, true);
      assert.ok(
        events.some((event) => event.line && event.line.includes('改用 tar -cf + node:zlib 压缩')),
        '应触发 gzip 回退分支',
      );
      assert.equal(fake.uploads.length, uploadsBefore + 2);
      const tarEntry = fake.cloudFiles().find((item) => item.filename === result.snapshotName);
      assert.ok(tarEntry, '回退后仍应上传 tar.gz');
      const sidecarEntry = fake.cloudFiles().find((item) => item.filename === result.sidecarName);
      assert.ok(sidecarEntry);
      const sidecarJson = readJson(sidecarEntry.path);
      assert.equal(sidecarJson.archive_sha256, sha256File(tarEntry.path));
      assert.equal(sidecarJson.archive_size, statSync(tarEntry.path).size);

      // 回退产出的 tar.gz 必须能正常解压
      rmSync(EXTRACT_DIR, { recursive: true, force: true });
      mkdirSync(EXTRACT_DIR, { recursive: true });
      execFileSync(resolveTarCommand(), ['-xzf', tarEntry.path, '-C', EXTRACT_DIR], { stdio: 'pipe' });
      assert.ok(existsSync(join(EXTRACT_DIR, 'workspace', 'plugins', 'plugin-a', 'index.js')));
      assert.ok(existsSync(join(EXTRACT_DIR, 'MANIFEST.json')));
    });
  }

  // ---------------------------------------------------------------- PASS 摘要
  const passed = checks.filter((item) => item.ok).length;
  assert.equal(passed, checks.length);
  console.log('\n============================================');
  console.log(`PASS —— ${passed}/${checks.length} 组用例全部通过`);
  console.log('覆盖：config(config.sh/config.json/defaults/link 发现) / scope(排除/prune/不可读/禁用)');
  console.log('      sidecar(MANIFEST/RESTORE/sidecar) / backup(指纹/打包/扫描/上传/归档/清理)');
  console.log('      backup(skip 与变更重传) / secret-scan(命中阻断) / rotation(保留与孤儿清单)');
  console.log('      cancel(AbortSignal 清理) / Windows 路径模拟 / tar gzip 回退');
  console.log(`沙箱：${sandbox}`);
  console.log('============================================');

  if (process.env.DSH_NATIVE_TEST_KEEP !== '1') {
    rmSync(sandbox, { recursive: true, force: true });
    console.log('沙箱已清理（DSH_NATIVE_TEST_KEEP=1 可保留排查）');
  }
}

main().catch((error) => {
  console.error('\nFAIL:', error?.stack || error);
  console.error(`沙箱保留用于排查：${sandbox}`);
  process.exitCode = 1;
});
