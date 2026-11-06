#!/usr/bin/env node
/**
 * host/restore.js 自测：在 /tmp 沙箱里造合成快照，离线验证
 * stage / diff / apply / 安全副本 / finalizeOnStartup / rollback / discard。
 *
 * 不联网、不写真实 HOME：HOME / DSH_HOME / DSH_WORKSPACE_DIR / DSH_SYNC_DIR /
 * DSH_MAINTENANCE_DIR 全部指向 /tmp/dsh-restore-unit-<pid>/。
 *
 * 运行：node test/restore-unit.mjs
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { createCore } from '../host/core.js';
import { createRestoreEngine } from '../host/restore.js';
import { compileExcludes, mirrorDirectory } from '../host/mirror.js';
import { pathInside, resolveTarCommand } from '../host/platform.js';

// ---------------------------------------------------------------- 沙箱与内容

const sandbox = join('/tmp', `dsh-restore-unit-${process.pid}`);
const HOME = join(sandbox, 'home');
const DSH_HOME = join(HOME, '.dsh');
const WORKSPACE = join(HOME, 'Documents', 'workspace');
const SYNC_DIR = join(HOME, '.dsh-sync');
const DATA_DIR = join(sandbox, 'data');
const CLOUD = join(sandbox, 'cloud');

const DEFAULT_FID = '210e76226f274d749cfc712725c72c68';
const MAP_SNAPSHOT = 'dsh-snap-2026-10-31_100000.tar.gz';

/** 各文件内容：刻意让“覆盖”两侧大小不同，避免和“未变”混淆。 */
const C = {
  localProfile: 'profile: old\n',
  snapProfile: 'profile: new-and-longer\n',
  localSkill: 'skill-old\n',
  snapSkill: 'skill-new-and-longer\n',
  localPluginOld: 'old-plugin-file\n',
  snapPluginNew: 'plugin-new-file\n',
  localOther: 'other-old\n',
  snapOther: 'other-new-and-longer\n',
  localSelf: 'self-old\n',
  snapSelf: 'self-new-and-longer\n',
  localSync: 'sync-old\n',
  quarkCliState: 'quark-cli-state\n',
  nodeModuleJunk: 'should-be-ignored\n',
  snapSync: 'sync-new-and-longer\n',
  runtimeSession: '{"runtime":true}\n',
  credentials: 'api_key: secret\n',
  syncState: 'state-keep\n',
  // 映射测试：包内 workspace 名称与本地落点不同名
  mappedProfile: 'mapped-profile-new-longer\n',
  mappedPlugin: 'mapped-plugin-new-longer\n',
  mappedRenamed: 'mapped-renamed-new-longer\n',
  localMappedPlugin: 'mapped-plugin-old\n',
  localMappedRenamed: 'mapped-renamed-old\n',
};

const bytes = (text) => Buffer.byteLength(text, 'utf8');
/** 造合成快照用的 tar（与引擎同一个解析函数；macOS 上是 /usr/bin/tar）。 */
const TAR_COMMAND = resolveTarCommand();

/** @param {string} rel @param {string} content */
function writeSandbox(rel, content) {
  const abs = join(sandbox, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function readSandbox(rel) {
  return readFileSync(join(sandbox, rel), 'utf8');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function makeTar(rootRel, archiveRel) {
  const root = join(sandbox, rootRel);
  const archive = join(sandbox, archiveRel);
  mkdirSync(dirname(archive), { recursive: true });
  execFileSync(TAR_COMMAND, ['-czf', archive, '-C', root, '.'], { stdio: 'pipe' });
  return archive;
}

function listDirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 造沙箱数据

function buildSandbox() {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });

  // 本机现状（fake HOME）
  writeSandbox('home/.dsh/profiles/desktop/cordis.patch.yml', C.localProfile);
  writeSandbox('home/.dsh/profiles/desktop/sessions/session-1.json', C.runtimeSession);
  writeSandbox('home/.dsh/.credentials.yaml', C.credentials);
  writeSandbox('home/.dsh/skills/quarkclouddrive/SKILL.md', C.localSkill);
  writeSandbox('home/.dsh/skills/quarkclouddrive/deepseek/task.json', C.quarkCliState);
  writeSandbox('home/.dsh/plugins/node_modules/junk.js', C.nodeModuleJunk);
  writeSandbox('home/.dsh/plugins/p1/old.js', C.localPluginOld);
  writeSandbox('home/Documents/workspace/dsh-maintenance-backup/package.json', C.localSelf);
  writeSandbox('home/Documents/workspace/other-plugin/index.js', C.localOther);
  writeSandbox('home/.dsh-sync/config.sh', C.localSync);
  writeSandbox('home/.dsh-sync/state/last.hash', C.syncState);

  // 合成快照 1（带 sidecar，完整）
  writeSandbox('snap1/dsh-home/profiles/desktop/cordis.patch.yml', C.snapProfile);
  writeSandbox('snap1/dsh-home/skills/quarkclouddrive/SKILL.md', C.snapSkill);
  writeSandbox('snap1/dsh-home/plugins/p1/plugin.js', C.snapPluginNew);
  writeSandbox('snap1/workspace/other-plugin/index.js', C.snapOther);
  writeSandbox('snap1/workspace/dsh-maintenance-backup/package.json', C.snapSelf);
  writeSandbox('snap1/dsh-sync/config.sh', C.snapSync);
  writeSandbox(
    'snap1/MANIFEST.json',
    JSON.stringify({ name: 'dsh-snap-2026-11-04_120000.tar.gz', file_count: 6, partial: false }, null, 2),
  );
  writeSandbox('snap1/RESTORE.md', '# 恢复说明\n');
  const snap1Tar = makeTar('snap1', 'cloud/dsh-snap-2026-11-04_120000.tar.gz');

  // 合成快照 2（无 sidecar，最小结构）
  writeSandbox('snap2/dsh-home/profiles/desktop/cordis.patch.yml', C.snapProfile);
  writeSandbox('snap2/MANIFEST.json', JSON.stringify({ name: 'dsh-snap-2026-11-03_080000.tar.gz', file_count: 1 }, null, 2));
  makeTar('snap2', 'cloud/dsh-snap-2026-11-03_080000.tar.gz');

  // 合成快照 3（网盘记录大小与实际不一致，用于校验失败分支）
  copyFileSync(join(sandbox, 'cloud/dsh-snap-2026-11-04_120000.tar.gz'), join(CLOUD, 'dsh-snap-2026-11-02_090000.tar.gz'));

  // 合成快照 4（sidecar 的 archive_sha256 错误，用于 SHA-256 校验失败分支）
  copyFileSync(join(sandbox, 'cloud/dsh-snap-2026-11-04_120000.tar.gz'), join(CLOUD, 'dsh-snap-2026-11-01_070000.tar.gz'));
  const snap1Dir = join(sandbox, 'snap1');
  const sidecar1 = {
    name: 'dsh-snap-2026-11-04_120000.tar.gz',
    created_at: '2026-11-04T12:00:00+0800',
    hostname: 'synthetic-host',
    file_count: 6,
    approx_size_mb: 0.0,
    partial: false,
    archive_sha256: sha256(snap1Tar),
    entries: [
      { dest: 'dsh-home/profiles', files: 1, bytes: bytes(C.snapProfile) },
      { dest: 'dsh-home/skills', files: 1, bytes: bytes(C.snapSkill) },
      { dest: 'dsh-home/plugins', files: 1, bytes: bytes(C.snapPluginNew) },
      { dest: 'workspace/other-plugin', files: 1, bytes: bytes(C.snapOther) },
      { dest: 'workspace/dsh-maintenance-backup', files: 1, bytes: bytes(C.snapSelf) },
      { dest: 'dsh-sync', files: 1, bytes: bytes(C.snapSync) },
    ],
    files: [
      ['dsh-home/profiles/desktop/cordis.patch.yml', bytes(C.snapProfile)],
      ['dsh-home/skills/quarkclouddrive/SKILL.md', bytes(C.snapSkill)],
      ['dsh-home/plugins/p1/plugin.js', bytes(C.snapPluginNew)],
      ['workspace/other-plugin/index.js', bytes(C.snapOther)],
      ['workspace/dsh-maintenance-backup/package.json', bytes(C.snapSelf)],
      ['dsh-sync/config.sh', bytes(C.snapSync)],
    ],
  };
  writeFileSync(join(CLOUD, 'dsh-snap-2026-11-04_120000.manifest.json'), `${JSON.stringify(sidecar1, null, 2)}\n`);
  writeFileSync(
    join(CLOUD, 'dsh-snap-2026-11-01_070000.manifest.json'),
    `${JSON.stringify(
      {
        name: 'dsh-snap-2026-11-01_070000.tar.gz',
        file_count: 1,
        archive_sha256: '0'.repeat(64),
        entries: [],
        files: [],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(CLOUD, 'notes.txt'), 'ignore me\n');

  // 合成快照 5：包内 workspace 名称与本地真实路径不同名（映射测试）
  writeSandbox('snapMap/dsh-home/profiles/desktop/cordis.patch.yml', C.mappedProfile);
  writeSandbox('snapMap/workspace/plugins/plugin-a/index.js', C.mappedPlugin);
  writeSandbox('snapMap/workspace/renamed-plugin/run.js', C.mappedRenamed);
  writeSandbox('snapMap/MANIFEST.json', JSON.stringify({ name: MAP_SNAPSHOT, file_count: 3 }, null, 2));
  makeTar('snapMap', `cloud/${MAP_SNAPSHOT}`);
  // 真实 config.sh 的落点：workspace/plugins → ~/Documents/workspace/dsh/plugins
  writeSandbox('home/Documents/workspace/dsh/plugins/plugin-a/index.js', C.localMappedPlugin);
  writeSandbox('home/Documents/workspace/overview/renamed-target/run.js', C.localMappedRenamed);

  return { snap1Dir, snap1Tar };
}

// ---------------------------------------------------------------- 假 quark

function makeFakeQuark() {
  /** @type {Map<string, {fid:string,name:string,path:string,listedSize:number}>} */
  const cloud = new Map();
  let seq = 0;

  function register(name, filePath, listedSize) {
    seq += 1;
    const rec = {
      fid: `fid-${String(seq).padStart(2, '0')}-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`,
      name,
      path: filePath,
      listedSize: listedSize === undefined ? statSync(filePath).size : listedSize,
    };
    cloud.set(rec.fid, rec);
    return rec;
  }

  const tar1 = register('dsh-snap-2026-11-04_120000.tar.gz', join(CLOUD, 'dsh-snap-2026-11-04_120000.tar.gz'));
  const sidecar1 = register(
    'dsh-snap-2026-11-04_120000.manifest.json',
    join(CLOUD, 'dsh-snap-2026-11-04_120000.manifest.json'),
  );
  register('dsh-snap-2026-11-03_080000.tar.gz', join(CLOUD, 'dsh-snap-2026-11-03_080000.tar.gz'));
  const tar3 = register(
    'dsh-snap-2026-11-02_090000.tar.gz',
    join(CLOUD, 'dsh-snap-2026-11-02_090000.tar.gz'),
    statSync(join(CLOUD, 'dsh-snap-2026-11-02_090000.tar.gz')).size + 128,
  );
  const tar4 = register('dsh-snap-2026-11-01_070000.tar.gz', join(CLOUD, 'dsh-snap-2026-11-01_070000.tar.gz'));
  register('dsh-snap-2026-11-01_070000.manifest.json', join(CLOUD, 'dsh-snap-2026-11-01_070000.manifest.json'));
  register(MAP_SNAPSHOT, join(CLOUD, MAP_SNAPSHOT));
  register('notes.txt', join(CLOUD, 'notes.txt'));

  const fakeQuark = {
    browseCalls: 0,
    parentFids: [],
    downloads: [],
    async browseAll(parentFid) {
      fakeQuark.browseCalls += 1;
      fakeQuark.parentFids.push(parentFid);
      const entries = [...cloud.values()].map((rec) => ({
        fid: rec.fid,
        filename: rec.name,
        size: rec.listedSize,
        createdAt: 0,
        updatedAt: 0,
        fileType: 'file',
      }));
      return { ok: true, entries, code: 0, msg: '' };
    },
    async download(fid, outDir, options = {}) {
      const rec = cloud.get(fid);
      if (!rec) return { ok: false, path: null, msg: '文件不存在' };
      mkdirSync(outDir, { recursive: true });
      const name = options.name || rec.name;
      const dest = join(outDir, name);
      copyFileSync(rec.path, dest);
      fakeQuark.downloads.push({ fid, name, dest });
      return { ok: true, path: dest, code: 0, msg: '' };
    },
  };
  return { fakeQuark, tar1, sidecar1, tar3, tar4 };
}

// ---------------------------------------------------------------- 测试脚手架

const checks = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, ok: true });
      console.log(`  ✔ ${name}`);
    })
    .catch((error) => {
      checks.push({ name, ok: false, error });
      console.error(`  ✘ ${name}`);
      throw error;
    });
}

function expectedLocalPreserved() {
  assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), C.localProfile);
  assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/SKILL.md'), C.localSkill);
  assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/deepseek/task.json'), C.quarkCliState);
  assert.equal(readSandbox('home/.dsh/plugins/node_modules/junk.js'), C.nodeModuleJunk);
  assert.equal(readSandbox('home/Documents/workspace/other-plugin/index.js'), C.localOther);
  assert.equal(readSandbox('home/Documents/workspace/dsh-maintenance-backup/package.json'), C.localSelf);
  assert.equal(readSandbox('home/.dsh-sync/config.sh'), C.localSync);
  assert.equal(readSandbox('home/.dsh/plugins/p1/old.js'), C.localPluginOld);
  assert.ok(existsSync(join(DSH_HOME, 'profiles/desktop/sessions/session-1.json')));
  assert.ok(existsSync(join(DSH_HOME, '.credentials.yaml')));
  assert.ok(existsSync(join(SYNC_DIR, 'state/last.hash')));
}

async function main() {
  if (!TAR_COMMAND) throw new Error('无法解析 tar 命令');
  console.log(`沙箱：${sandbox}（tar: ${TAR_COMMAND}）`);
  buildSandbox();
  const { fakeQuark, tar3, tar4 } = makeFakeQuark();

  // 环境必须在 createCore 之前设置（createCore 读取 env）
  process.env.HOME = HOME;
  process.env.DSH_HOME = DSH_HOME;
  process.env.DSH_WORKSPACE_DIR = WORKSPACE;
  process.env.DSH_SYNC_DIR = SYNC_DIR;
  process.env.DSH_MAINTENANCE_DIR = DATA_DIR;
  delete process.env.DSH_SYNC_DSH_FID;

  const logs = [];
  const logger = (message, level = 'info') => logs.push([level, message]);
  const core = createCore({});
  assert.equal(core.paths.home, HOME, 'core.paths.home 应指向沙箱 HOME');
  assert.equal(core.paths.dshHome, DSH_HOME);
  assert.equal(core.paths.workspace, WORKSPACE);
  const engine = createRestoreEngine({ core, quark: fakeQuark, logger });

  let staged = null;
  let applyResult = null;

  await check('导出接口与契约完全一致', () => {
    assert.deepEqual(Object.keys(engine).sort(), [
      'ackPending',
      'apply',
      'discard',
      'finalizeOnStartup',
      'folders',
      'inspectPending',
      'listSafetyBackups',
      'listSnapshots',
      'preview',
      'rollback',
      'stage',
    ]);
    for (const method of Object.keys(engine)) assert.equal(typeof engine[method], 'function', `${method} 应为函数`);
    assert.equal(typeof fakeQuark.browseAll, 'function');
  });

  console.log('\n[1] 快照列表与预览');
  await check('listSnapshots 解析文件名、createdAt、sidecar 映射、排序', async () => {
    const snapshots = await engine.listSnapshots({ refresh: true });
    assert.equal(fakeQuark.parentFids.at(-1), DEFAULT_FID);
    assert.equal(snapshots.length, 5);
    assert.deepEqual(
      snapshots.map((item) => item.name),
      [
        'dsh-snap-2026-11-04_120000.tar.gz',
        'dsh-snap-2026-11-03_080000.tar.gz',
        'dsh-snap-2026-11-02_090000.tar.gz',
        'dsh-snap-2026-11-01_070000.tar.gz',
        MAP_SNAPSHOT,
      ],
    );
    const first = snapshots[0];
    assert.equal(first.createdAt, new Date(2026, 10, 4, 12, 0, 0).getTime());
    assert.equal(typeof first.ageDays, 'number');
    assert.ok(first.ageDays >= 0);
    assert.ok(first.sidecarFid, '11-04 快照应有 sidecarFid');
    assert.ok(typeof first.sidecarSize === 'number');
    assert.equal(snapshots[1].sidecarFid, null, '11-03 快照没有 sidecar');
    assert.equal(snapshots[2].sidecarFid, null, '11-02 快照没有 sidecar');
    assert.ok(!snapshots.some((item) => item.name === 'notes.txt'), '非快照文件应忽略');
  });

  await check('listSnapshots 30 秒缓存 + refresh 强刷', async () => {
    const before = fakeQuark.browseCalls;
    await engine.listSnapshots();
    await engine.listSnapshots({});
    assert.equal(fakeQuark.browseCalls, before, '缓存期内不应重新拉列表');
    await engine.listSnapshots({ refresh: true });
    assert.equal(fakeQuark.browseCalls, before + 1, 'refresh 应重新拉列表');
  });

  await check('preview 优先解析 sidecar', async () => {
    const preview = await engine.preview({ name: 'dsh-snap-2026-11-04_120000.tar.gz' });
    assert.equal(preview.available, true);
    assert.equal(preview.source, 'sidecar');
    assert.equal(preview.manifest.file_count, 6);
    assert.equal(preview.manifest.entries.length, 6);
    assert.equal(preview.manifest.files.length, 6);
    assert.match(preview.manifest.archive_sha256, /^[0-9a-f]{64}$/);
  });

  await check('preview 没有 sidecar 时 available:false 并说明', async () => {
    const preview = await engine.preview({ name: 'dsh-snap-2026-11-03_080000.tar.gz' });
    assert.equal(preview.available, false);
    assert.equal(preview.source, 'none');
    assert.equal(preview.manifest, null);
    assert.match(preview.message, /sidecar/);
  });

  await check('preview 未知快照抛错', async () => {
    await assert.rejects(() => engine.preview({ name: 'dsh-snap-1999-01-01_000000.tar.gz' }), /找不到快照/);
    await assert.rejects(() => engine.preview({ name: '../../etc/passwd' }), /无效的快照名称/);
  });

  console.log('\n[2] 阶段一 stage：解压 + 差异');
  await check('stage 下载/解压/校验并生成差异（不修改本机目标）', async () => {
    staged = await engine.stage({ name: 'dsh-snap-2026-11-04_120000.tar.gz', scope: 'all', includeSelf: false });
    assert.equal(staged.snapshotName, 'dsh-snap-2026-11-04_120000.tar.gz');
    assert.equal(staged.scope, 'all');
    assert.equal(staged.includeSelf, false);
    assert.ok(existsSync(staged.dir));
    assert.ok(existsSync(join(staged.dir, 'root/dsh-home')));
    assert.ok(existsSync(join(staged.dir, 'staging.json')));
    assert.ok(
      !listDirSafe(staged.dir).some((name) => name.endsWith('.tar.gz')),
      '解压后应删除归档 tar',
    );
    const staging = core.readJson(join(staged.dir, 'staging.json'), null);
    assert.equal(staging.phase, 'staged');
    assert.equal(staging.diff.counts.added, 1);
    assert.ok(logs.some(([, message]) => message.includes('校验快照 SHA-256')), '应执行 sidecar 的 SHA-256 校验');
    assert.ok(
      fakeQuark.downloads.some((item) => item.name.endsWith('.manifest.json')),
      '应只下载小 sidecar 做校验',
    );
    // stage 不修改任何目标
    expectedLocalPreserved();
  });

  await check('diff 计数 / 字节 / samples / targets / protected 正确', async () => {
    const { diff } = staged;
    assert.deepEqual(diff.counts, { added: 1, overwritten: 4, deleted: 1, unchanged: 0 });
    assert.deepEqual(diff.bytes, {
      added: bytes(C.snapPluginNew),
      overwritten:
        bytes(C.snapProfile) + bytes(C.snapSkill) + bytes(C.snapOther) + bytes(C.snapSync),
      deleted: bytes(C.localPluginOld),
    });
    assert.deepEqual(diff.samples.added, ['dsh-home/plugins/p1/plugin.js']);
    assert.deepEqual(diff.samples.deleted, ['dsh-home/plugins/p1/old.js']);
    assert.equal(diff.samples.overwritten.length, 4);
    assert.ok(diff.samples.overwritten.includes('dsh-home/profiles/desktop/cordis.patch.yml'));
    assert.ok(!diff.samples.deleted.includes('dsh-home/profiles/desktop/sessions/session-1.json'));
    assert.deepEqual(
      diff.targets.map((item) => item.prefix),
      ['dsh-home/plugins', 'dsh-home/profiles', 'dsh-home/skills', 'workspace/other-plugin', 'dsh-sync'],
    );
    for (const target of diff.targets) {
      assert.ok(target.target.startsWith(HOME), `${target.prefix} 目标应解析到沙箱 HOME`);
      assert.equal(target.snapshotFiles > 0, true);
    }
    const protectedPaths = new Set(diff.protected.map((item) => item.path));
    for (const path of [
      'dsh-home/profiles/desktop/sessions',
      'dsh-home/skills/quarkclouddrive/deepseek',
      'dsh-home/.credentials.yaml',
      'dsh-sync/state',
      'workspace/dsh-maintenance-backup',
    ]) {
      assert.ok(protectedPaths.has(path), `protected 应包含 ${path}`);
    }
    const self = diff.protected.find((item) => item.path === 'workspace/dsh-maintenance-backup');
    assert.match(self.reason, /维护插件自身/);
    // 未传 resolveSources 时 workspace 走默认兜底，应给出可核对的 warning
    assert.ok(
      diff.warnings.some((line) => line.includes('workspace/other-plugin') && line.includes('没有可用的同步映射')),
      '无映射时应有兜底 warning',
    );
    assert.ok(!diff.warnings.some((line) => line.includes('不完整快照')));
  });

  await check('stage 拒绝大小不一致与 SHA-256 不匹配', async () => {
    await assert.rejects(
      () => engine.stage({ name: 'dsh-snap-2026-11-02_090000.tar.gz', scope: 'all', includeSelf: false }),
      /大小与网盘记录不一致/,
    );
    await assert.rejects(
      () => engine.stage({ name: 'dsh-snap-2026-11-01_070000.tar.gz', scope: 'all', includeSelf: false }),
      /SHA-256 不匹配/,
    );
    // 失败后不应残留暂存区
    assert.equal(listDirSafe(core.paths.stagingRoot).length, 1, '只应保留成功的那一次暂存');
    assert.ok(tar3 && tar4);
  });

  await check('stage 未知快照 / 非法 scope 抛错', async () => {
    await assert.rejects(() => engine.stage({ name: 'dsh-snap-1999-01-01_000000.tar.gz' }), /找不到快照/);
    await assert.rejects(
      () => engine.stage({ name: 'dsh-snap-2026-11-04_120000.tar.gz', scope: 'nope' }),
      /无效的还原范围/,
    );
  });

  console.log('\n[3] 阶段二 apply：安全副本 + mirror');
  let ensureSelfRegistrationCalls = 0;
  await check('apply 生成安全副本、替换文件、写 marker、不重启不清理暂存', async () => {
    applyResult = await engine.apply({
      stagingId: staged.stagingId,
      scope: 'all',
      includeSelf: false,
      ensureSelfRegistration: async () => {
        ensureSelfRegistrationCalls += 1;
      },
    });
    assert.equal(applyResult.ok, true);
    assert.equal(applyResult.restartRequired, true);
    assert.equal(applyResult.selfSkipped, true);
    assert.equal(ensureSelfRegistrationCalls, 1);
    assert.equal(applyResult.applied.length, 5);
    assert.deepEqual(applyResult.applied.map((item) => item.prefix).sort(), [
      'dsh-home/plugins',
      'dsh-home/profiles',
      'dsh-home/skills',
      'dsh-sync',
      'workspace/other-plugin',
    ]);
    // 安全副本
    assert.ok(existsSync(applyResult.safety.path));
    assert.ok(applyResult.safety.bytes > 0);
    assert.equal(applyResult.safety.files, 5);
    const safetyInfo = core.readJson(join(applyResult.safety.path, 'safety.json'), null);
    assert.equal(safetyInfo.targets.length, 5);
    assert.ok(safetyInfo.targets.every((item) => item.existed && existsSync(item.archive)));
    const backups = await engine.listSafetyBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].path, applyResult.safety.path);
    // marker
    const pending = await engine.inspectPending();
    assert.equal(pending.phase, 'applied');
    assert.equal(pending.safetyPath, applyResult.safety.path);
    assert.equal(pending.snapshotName, staged.snapshotName);
    assert.ok(existsSync(core.paths.pendingFile));
    // 文件已被替换 / 删除 / 新增
    assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), C.snapProfile);
    assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/SKILL.md'), C.snapSkill);
    assert.equal(readSandbox('home/Documents/workspace/other-plugin/index.js'), C.snapOther);
    assert.equal(readSandbox('home/.dsh-sync/config.sh'), C.snapSync);
    assert.ok(existsSync(join(DSH_HOME, 'plugins/p1/plugin.js')));
    assert.ok(!existsSync(join(DSH_HOME, 'plugins/p1/old.js')), 'mirror 应删除快照中不存在的文件');
    // 运行态与密钥、维护插件自身保持原样
    assert.ok(existsSync(join(DSH_HOME, 'profiles/desktop/sessions/session-1.json')), 'sessions 不应被删除');
    assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/deepseek/task.json'), C.quarkCliState);
    assert.equal(readSandbox('home/.dsh/plugins/node_modules/junk.js'), C.nodeModuleJunk, 'node_modules 不应被删除');
    assert.equal(readSandbox('home/.dsh/.credentials.yaml'), C.credentials);
    assert.ok(existsSync(join(SYNC_DIR, 'state/last.hash')), 'dsh-sync/state 不应被删除');
    assert.equal(readSandbox('home/Documents/workspace/dsh-maintenance-backup/package.json'), C.localSelf);
    // 暂存区仍在（apply 不清理）
    assert.ok(existsSync(staged.dir));
    assert.ok(logs.some(([, message]) => message.includes('安全副本')));
  });

  await check('apply 参数缺失时抛错', async () => {
    await assert.rejects(() => engine.apply({ stagingId: 'no-such-staging' }), /找不到暂存区/);
    await assert.rejects(() => engine.apply({ stagingId: '../../etc' }), /无效的暂存区/);
  });

  console.log('\n[4] finalizeOnStartup / ackPending');
  await check('finalizeOnStartup 校验目标、清理 marker 与暂存区、写 lastRestore', async () => {
    // 模拟 DSH 重启：真实重启后 Host 进程 pid 会变化，finalize 才会收尾
    const pendingFile = join(core.paths.dataDir, 'restore', 'pending.json');
    const pendingMarker = JSON.parse(readFileSync(pendingFile, 'utf8'));
    pendingMarker.applyPid = -1;
    writeFileSync(pendingFile, JSON.stringify(pendingMarker));
    const finalized = await engine.finalizeOnStartup();
    assert.ok(finalized.marker);
    assert.equal(finalized.marker.phase, 'applied');
    assert.equal(finalized.result.pendingAck, true);
    assert.deepEqual(finalized.result.missingTargets, []);
    assert.equal(finalized.result.snapshotName, 'dsh-snap-2026-11-04_120000.tar.gz');
    assert.ok(!existsSync(core.paths.pendingFile), 'marker 应被删除');
    assert.equal(listDirSafe(core.paths.stagingRoot).length, 0, '暂存区应被清空');
    assert.equal(await engine.inspectPending(), null);
    const state = core.readJson(core.paths.stateFile, null);
    assert.equal(state.lastRestore.snapshotName, 'dsh-snap-2026-11-04_120000.tar.gz');
    assert.equal(state.lastRestore.pendingAck, true);
    assert.equal(state.lastRestore.restartRequired, false);
  });

  await check('ackPending 幂等且清除 pendingAck', async () => {
    await engine.ackPending();
    await engine.ackPending();
    const state = core.readJson(core.paths.stateFile, null);
    assert.equal(state.lastRestore.pendingAck, false);
    assert.ok(!existsSync(core.paths.pendingFile));
  });

  await check('没有 marker 时 finalizeOnStartup 返回空结果', async () => {
    const finalized = await engine.finalizeOnStartup();
    assert.equal(finalized.marker, null);
    assert.equal(finalized.result, null);
  });

  console.log('\n[5] rollback');
  await check('rollback 用安全副本恢复原文件、保留 safety、不碰 self/运行态', async () => {
    const rolled = await engine.rollback();
    assert.equal(rolled.ok, true);
    assert.equal(rolled.targets.length, 5);
    assert.equal(rolled.safetyPath, applyResult.safety.path);
    assert.deepEqual(rolled.leftovers, []);
    assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), C.localProfile);
    assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/SKILL.md'), C.localSkill);
    assert.equal(readSandbox('home/Documents/workspace/other-plugin/index.js'), C.localOther);
    assert.equal(readSandbox('home/.dsh-sync/config.sh'), C.localSync);
    assert.ok(existsSync(join(DSH_HOME, 'plugins/p1/old.js')), '回滚应恢复被删除的文件');
    assert.ok(!existsSync(join(DSH_HOME, 'plugins/p1/plugin.js')), '回滚应删除还原新增的文件');
    assert.ok(existsSync(join(DSH_HOME, 'profiles/desktop/sessions/session-1.json')));
    assert.equal(readSandbox('home/.dsh/skills/quarkclouddrive/deepseek/task.json'), C.quarkCliState);
    assert.equal(readSandbox('home/.dsh/plugins/node_modules/junk.js'), C.nodeModuleJunk);
    assert.equal(readSandbox('home/.dsh/.credentials.yaml'), C.credentials);
    assert.ok(existsSync(join(SYNC_DIR, 'state/last.hash')));
    assert.equal(readSandbox('home/Documents/workspace/dsh-maintenance-backup/package.json'), C.localSelf);
    const backups = await engine.listSafetyBackups();
    assert.equal(backups.length, 1, '回滚后仍保留安全副本以便再次回滚');
    const state = core.readJson(core.paths.stateFile, null);
    assert.equal(state.lastRestore.rolledBack, true);
    await engine.ackPending();
  });

  await check('没有安全副本时 rollback 抛错', async () => {
    // 临时移走唯一一套安全副本后再验证（随后恢复，避免影响后续）
    const backupRoot = core.paths.safetyDir;
    const moved = join(sandbox, 'safety-moved');
    rmSync(moved, { recursive: true, force: true });
    execFileSync('/bin/mv', [join(backupRoot, readdirSync(backupRoot).find((name) => !name.startsWith('.'))), moved]);
    try {
      await assert.rejects(() => engine.rollback(), /没有可用的安全副本/);
    } finally {
      execFileSync('/bin/mv', [moved, join(backupRoot, 'restored-backup')]);
    }
    assert.equal(listDirSafe(backupRoot).length, 1);
  });

  console.log('\n[5b] finalizeOnStartup 中断分支');
  await check('phase=applying 的 marker 不擅自改文件，记录可回滚状态并清理', async () => {
    const fakeStaging = join(core.paths.stagingRoot, 'stg-fake-interrupted');
    mkdirSync(join(fakeStaging, 'root', 'dsh-home'), { recursive: true });
    core.writeJson(join(fakeStaging, 'staging.json'), { stagingId: 'stg-fake-interrupted' });
    core.writeJson(core.paths.pendingFile, {
      id: 'rst-fake-interrupted',
      snapshotName: 'dsh-snap-2026-11-04_120000.tar.gz',
      scope: 'all',
      includeSelf: false,
      phase: 'applying',
      startedAt: core.now() - 60_000,
      finishedAt: null,
      safetyPath: null,
      targets: [{ prefix: 'dsh-home/profiles', target: join(DSH_HOME, 'profiles') }],
      result: null,
    });
    const beforeProfile = readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml');
    const finalized = await engine.finalizeOnStartup();
    assert.equal(finalized.marker.phase, 'applying');
    assert.equal(finalized.result.interrupted, true);
    assert.equal(finalized.result.canRollback, false);
    assert.match(finalized.result.message, /中断/);
    assert.ok(!existsSync(core.paths.pendingFile));
    assert.equal(listDirSafe(core.paths.stagingRoot).length, 0, '中断后应清理暂存区');
    assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), beforeProfile, '中断分支不应改动文件');
    const state = core.readJson(core.paths.stateFile, null);
    assert.equal(state.lastRestore.interrupted, true);
    await engine.ackPending();
  });

  console.log('\n[6] includeSelf 与 discard');
  await check('includeSelf=true 时 workspace 目标包含维护插件自身', async () => {
    const stagedSelf = await engine.stage({
      name: 'dsh-snap-2026-11-04_120000.tar.gz',
      scope: 'workspace',
      includeSelf: true,
    });
    assert.deepEqual(
      stagedSelf.diff.targets.map((item) => item.prefix),
      ['workspace/dsh-maintenance-backup', 'workspace/other-plugin'],
    );
    assert.deepEqual(stagedSelf.diff.counts, { added: 0, overwritten: 2, deleted: 0, unchanged: 0 });
    assert.ok(
      !stagedSelf.diff.protected.some((item) => item.path === 'workspace/dsh-maintenance-backup'),
      'includeSelf=true 时 self 不应列入 protected',
    );
    assert.ok(stagedSelf.diff.targets.every((item) => item.counts.overwritten === 1));
    assert.equal(readSandbox('home/Documents/workspace/dsh-maintenance-backup/package.json'), C.localSelf);
    // includeSelf=false 时 workspace scope 会跳过 self
    const stagedNoSelf = await engine.stage({
      name: 'dsh-snap-2026-11-04_120000.tar.gz',
      scope: 'workspace',
      includeSelf: false,
    });
    assert.deepEqual(
      stagedNoSelf.diff.targets.map((item) => item.prefix),
      ['workspace/other-plugin'],
    );
    assert.ok(stagedNoSelf.diff.protected.some((item) => item.path === 'workspace/dsh-maintenance-backup'));
    // discard 两个暂存区
    assert.deepEqual(await engine.discard({ stagingId: stagedSelf.stagingId }), { ok: true });
    assert.ok(!existsSync(stagedSelf.dir));
    assert.deepEqual(await engine.discard({ stagingId: stagedNoSelf.stagingId }), { ok: true });
    assert.ok(!existsSync(stagedNoSelf.dir));
    assert.equal(listDirSafe(core.paths.stagingRoot).length, 0);
    assert.deepEqual(await engine.discard({ stagingId: 'not-there' }), { ok: true });
  });

  console.log('\n[7] 环境变量覆盖 FID');
  await check('DSH_SYNC_DSH_FID 覆盖默认目录 FID', async () => {
    process.env.DSH_SYNC_DSH_FID = 'override-dsh-fid';
    try {
      const engine2 = createRestoreEngine({ core, quark: fakeQuark, logger });
      await engine2.listSnapshots({ refresh: true });
      assert.equal(fakeQuark.parentFids.at(-1), 'override-dsh-fid');
    } finally {
      delete process.env.DSH_SYNC_DSH_FID;
    }
  });
  await check('resolveFolders（同步配置）优先于 env，失败时回退 env', async () => {
    process.env.DSH_SYNC_DSH_FID = 'env-dsh-fid';
    try {
      const configured = createRestoreEngine({
        core,
        quark: fakeQuark,
        logger,
        resolveFolders: async () => ({ dshFid: 'config-dsh-fid', archiveFid: 'config-archive-fid' }),
      });
      await configured.listSnapshots({ refresh: true });
      assert.equal(fakeQuark.parentFids.at(-1), 'config-dsh-fid');
      assert.deepEqual(await configured.folders(), { dshFid: 'config-dsh-fid', archiveFid: 'config-archive-fid' });
      const broken = createRestoreEngine({
        core,
        quark: fakeQuark,
        logger,
        resolveFolders: async () => {
          throw new Error('config unreadable');
        },
      });
      await broken.listSnapshots({ refresh: true });
      assert.equal(fakeQuark.parentFids.at(-1), 'env-dsh-fid');
    } finally {
      delete process.env.DSH_SYNC_DSH_FID;
    }
  });

  console.log('\n[8] resolveSources 映射（包内名称 ≠ 本地路径）');
  const customSources = [
    { src: join(DSH_HOME, 'profiles'), dest: 'dsh-home/profiles' },
    // 尾部分隔符 + 相对写法都要归一化
    { src: `${join(WORKSPACE, 'dsh/plugins')}/`, dest: 'workspace/plugins' },
    { src: join(WORKSPACE, 'overview/renamed-target'), dest: 'workspace/grouped/renamed-plugin' },
    { src: SYNC_DIR, dest: 'dsh-sync' },
  ];
  const mappedEngine = createRestoreEngine({
    core,
    quark: fakeQuark,
    logger,
    resolveSources: async () => customSources,
  });
  let mappedStaged = null;

  await check('精确 dest 匹配 + basename 唯一匹配解析出正确落点', async () => {
    mappedStaged = await mappedEngine.stage({ name: MAP_SNAPSHOT, scope: 'all', includeSelf: false });
    const byPrefix = new Map(mappedStaged.diff.targets.map((item) => [item.prefix, item.target]));
    assert.equal(byPrefix.get('dsh-home/profiles'), join(DSH_HOME, 'profiles'));
    assert.equal(byPrefix.get('workspace/plugins'), join(WORKSPACE, 'dsh/plugins'));
    assert.equal(
      byPrefix.get('workspace/renamed-plugin'),
      join(WORKSPACE, 'overview/renamed-target'),
      'basename 唯一匹配应解析到 config.sh 的 src',
    );
    assert.ok(
      !mappedStaged.diff.warnings.some((line) => line.includes('未在当前 config.sh 中找到映射')),
      '所有 workspace 目标都已映射，不应有兜底 warning',
    );
    assert.deepEqual(mappedStaged.diff.counts, { added: 0, overwritten: 3, deleted: 0, unchanged: 0 });
    // 默认路径不得被创建/改动
    assert.ok(!existsSync(join(WORKSPACE, 'plugins')), '不应落点到默认 workspace/plugins');
    assert.ok(!existsSync(join(WORKSPACE, 'renamed-plugin')), '不应落点到默认 workspace/renamed-plugin');
    assert.equal(readSandbox('home/Documents/workspace/dsh/plugins/plugin-a/index.js'), C.localMappedPlugin);
    assert.equal(readSandbox('home/Documents/workspace/overview/renamed-target/run.js'), C.localMappedRenamed);
  });

  await check('apply / safety / finalize / rollback 都按映射落点工作', async () => {
    const applied = await mappedEngine.apply({
      stagingId: mappedStaged.stagingId,
      scope: 'all',
      includeSelf: false,
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.applied.length, 3);
    assert.equal(readSandbox('home/Documents/workspace/dsh/plugins/plugin-a/index.js'), C.mappedPlugin);
    assert.equal(readSandbox('home/Documents/workspace/overview/renamed-target/run.js'), C.mappedRenamed);
    assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), C.mappedProfile);
    const safetyInfo = core.readJson(join(applied.safety.path, 'safety.json'), null);
    const safetyTargets = new Set(safetyInfo.targets.map((item) => item.target));
    assert.ok(safetyTargets.has(join(WORKSPACE, 'dsh/plugins')));
    assert.ok(safetyTargets.has(join(WORKSPACE, 'overview/renamed-target')));
    // 两阶段：apply 后 marker 仍是 applied，staging 未被清理，也没有额外 finalize
    assert.equal((await mappedEngine.inspectPending()).phase, 'applied');
    assert.ok(existsSync(mappedStaged.dir), 'apply 不应清理 staging');
    // 启动收尾只清 marker/staging，不改文件（模拟重启后 pid 变化）
    const restartMarkerPath = join(core.paths.dataDir, 'restore', 'pending.json');
    const restartMarker = JSON.parse(readFileSync(restartMarkerPath, 'utf8'));
    restartMarker.applyPid = -1;
    writeFileSync(restartMarkerPath, JSON.stringify(restartMarker));
    const finalized = await mappedEngine.finalizeOnStartup();
    assert.equal(finalized.result.pendingAck, true);
    assert.ok(!existsSync(core.paths.pendingFile));
    // 回滚同样回到映射后的自定义落点
    const rolled = await mappedEngine.rollback();
    assert.equal(rolled.ok, true);
    assert.equal(readSandbox('home/Documents/workspace/dsh/plugins/plugin-a/index.js'), C.localMappedPlugin);
    assert.equal(readSandbox('home/Documents/workspace/overview/renamed-target/run.js'), C.localMappedRenamed);
    assert.equal(readSandbox('home/.dsh/profiles/desktop/cordis.patch.yml'), C.localProfile);
    await mappedEngine.ackPending();
  });

  console.log('\n[9] 无 resolveSources / resolveSources 失败时的固定映射兜底');
  await check('未提供 resolveSources 时按默认 workspace/<x> 兜底并写 warning', async () => {
    const staged = await engine.stage({ name: MAP_SNAPSHOT, scope: 'workspace', includeSelf: false });
    const byPrefix = new Map(staged.diff.targets.map((item) => [item.prefix, item.target]));
    assert.equal(byPrefix.get('workspace/plugins'), join(WORKSPACE, 'plugins'));
    assert.equal(byPrefix.get('workspace/renamed-plugin'), join(WORKSPACE, 'renamed-plugin'));
    assert.ok(staged.diff.warnings.some((line) => line.includes('没有可用的同步映射')));
    assert.ok(!existsSync(join(WORKSPACE, 'plugins')), 'stage 阶段不应创建默认目标目录');
    await engine.discard({ stagingId: staged.stagingId });
  });

  await check('resolveSources 抛错时同样回退默认映射并写 warning', async () => {
    const failingEngine = createRestoreEngine({
      core,
      quark: fakeQuark,
      logger,
      resolveSources: async () => {
        throw new Error('config.sh 解析失败（模拟）');
      },
    });
    const staged = await failingEngine.stage({ name: MAP_SNAPSHOT, scope: 'workspace', includeSelf: false });
    const byPrefix = new Map(staged.diff.targets.map((item) => [item.prefix, item.target]));
    assert.equal(byPrefix.get('workspace/plugins'), join(WORKSPACE, 'plugins'));
    assert.ok(staged.diff.warnings.some((line) => line.includes('没有可用的同步映射')));
    await failingEngine.discard({ stagingId: staged.stagingId });
  });

  console.log('\n[10] 跨平台：Windows 路径语义 / mirror / tar 覆盖');

  await check('pathInside 的 win32 盘符、大小写、分隔符语义', () => {
    assert.equal(pathInside('C:\\Users\\A', 'c:\\users\\a\\Documents\\x', 'win32'), true);
    assert.equal(pathInside('C:\\Users\\A', 'C:/Users/A/AppData', 'win32'), true);
    assert.equal(pathInside('C:\\Users\\A', 'C:\\Users\\AB\\x', 'win32'), false);
    assert.equal(pathInside('C:\\Users\\A', 'D:\\Users\\A\\x', 'win32'), false);
    assert.equal(pathInside('C:\\Users\\A', 'C:\\Users\\A', 'win32'), true);
    assert.equal(pathInside('/Users/a', '/Users/a/Documents', 'darwin'), true);
    assert.equal(pathInside('/Users/a', '/Users/ab', 'darwin'), false);
    assert.equal(pathInside('/Users/a', '/Users/a', 'darwin'), true);
    assert.equal(pathInside('/Users/a', '/Users/b', 'darwin'), false);
  });

  await check('createRestoreEngine 可注入 platform，diff 相对路径统一 posix', async () => {
    const winEngine = createRestoreEngine({ core, quark: fakeQuark, logger, platform: 'win32' });
    const staged = await winEngine.stage({ name: MAP_SNAPSHOT, scope: 'workspace', includeSelf: false });
    assert.ok(staged.diff.targets.length >= 1);
    for (const target of staged.diff.targets) {
      assert.ok(!target.prefix.includes('\\'), `prefix 应为 posix：${target.prefix}`);
      assert.ok(target.target.startsWith(HOME), '目标仍应解析到沙箱 HOME');
    }
    for (const kind of ['added', 'overwritten', 'deleted']) {
      for (const sample of staged.diff.samples[kind]) {
        assert.ok(!sample.includes('\\'), `相对路径应为 posix：${sample}`);
      }
    }
    await winEngine.discard({ stagingId: staged.stagingId });
    // 非法 platform 值回退到 process.platform
    const fallbackEngine = createRestoreEngine({ core, quark: fakeQuark, logger, platform: '' });
    assert.equal(typeof fallbackEngine.stage, 'function');
  });

  await check('mirrorDirectory：add / overwrite / delete / exclude（直接调用）', async () => {
    const srcRoot = join(sandbox, 'mirror-src');
    const dstRoot = join(sandbox, 'mirror-dst');
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(dstRoot, { recursive: true, force: true });
    mkdirSync(join(srcRoot, 'sub'), { recursive: true });
    mkdirSync(join(srcRoot, 'desktop'), { recursive: true });
    writeFileSync(join(srcRoot, 'a.txt'), 'new-a\n');
    writeFileSync(join(srcRoot, 'sub', 'b.txt'), 'new-b\n');
    writeFileSync(join(srcRoot, 'desktop', 'other.txt'), 'new-other\n');
    mkdirSync(join(dstRoot, 'desktop', 'sessions'), { recursive: true });
    mkdirSync(join(dstRoot, 'node_modules'), { recursive: true });
    writeFileSync(join(dstRoot, 'a.txt'), 'old-a-longer\n');
    writeFileSync(join(dstRoot, 'stale.txt'), 'stale\n');
    writeFileSync(join(dstRoot, 'desktop', 'stale-local.txt'), 'stale-local\n');
    writeFileSync(join(dstRoot, 'node_modules', 'junk.txt'), 'keep-nm\n');
    writeFileSync(join(dstRoot, 'desktop', 'sessions', 's.json'), 'keep-session\n');
    const result = await mirrorDirectory({
      source: srcRoot,
      target: dstRoot,
      excludes: ['node_modules', '*/sessions'],
    });
    assert.equal(result.errors.length, 0);
    assert.equal(readFileSync(join(dstRoot, 'a.txt'), 'utf8'), 'new-a\n', 'mirror 应覆盖同路径文件');
    assert.equal(readFileSync(join(dstRoot, 'sub', 'b.txt'), 'utf8'), 'new-b\n', 'mirror 应新增文件/目录');
    assert.ok(!existsSync(join(dstRoot, 'stale.txt')), 'mirror 应删除多余文件');
    assert.ok(!existsSync(join(dstRoot, 'desktop', 'stale-local.txt')), 'mirror 应删除已有目录内多余文件');
    assert.equal(readFileSync(join(dstRoot, 'desktop', 'other.txt'), 'utf8'), 'new-other\n');
    assert.equal(readFileSync(join(dstRoot, 'node_modules', 'junk.txt'), 'utf8'), 'keep-nm\n', 'node_modules 应排除');
    assert.equal(
      readFileSync(join(dstRoot, 'desktop', 'sessions', 's.json'), 'utf8'),
      'keep-session\n',
      '运行态子树应排除',
    );
    assert.equal(result.files, 3);
    assert.equal(result.removed, 2);
    const isExcluded = compileExcludes(['node_modules', '*.log', 'quarkclouddrive/deepseek']);
    assert.equal(isExcluded('foo/node_modules/bar.js'), true);
    assert.equal(isExcluded('logs/app.log'), true);
    assert.equal(isExcluded('quarkclouddrive/deepseek/task.json'), true);
    assert.equal(isExcluded('quarkclouddrive/SKILL.md'), false);
    assert.equal(isExcluded('profiles/desktop/cordis.patch.yml'), false);
    rmSync(srcRoot, { recursive: true, force: true });
    rmSync(dstRoot, { recursive: true, force: true });
  });

  await check('DSH_MAINTENANCE_TAR 覆盖 tar：stage 解压 / 安全副本 / rollback 解压都走它', async () => {
    // 准备本机已存在的目标，确保 apply 会为它们创建安全副本（触发 -czf）
    mkdirSync(join(WORKSPACE, 'plugins', 'plugin-a'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'plugins', 'plugin-a', 'index.js'), 'fallback-old\n');
    mkdirSync(join(WORKSPACE, 'renamed-plugin'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'renamed-plugin', 'run.js'), 'fallback-old\n');

    const callsLog = join(sandbox, 'tar-calls.log');
    const fakeTar = join(sandbox, 'fake-tar.sh');
    writeFileSync(
      fakeTar,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callsLog}"\nexec "${TAR_COMMAND}" "$@"\n`,
      { mode: 0o755 },
    );
    process.env.DSH_MAINTENANCE_TAR = fakeTar;
    try {
      assert.equal(resolveTarCommand(), fakeTar, 'DSH_MAINTENANCE_TAR 应覆盖 tar 解析');
      const staged = await engine.stage({ name: MAP_SNAPSHOT, scope: 'workspace', includeSelf: false });
      const applied = await engine.apply({ stagingId: staged.stagingId, scope: 'workspace', includeSelf: false });
      assert.equal(applied.ok, true);
      assert.equal(applied.applied.length, 2);
      // 模拟 DSH 重启后收尾
      const markerPath = join(core.paths.dataDir, 'restore', 'pending.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      marker.applyPid = -1;
      writeFileSync(markerPath, JSON.stringify(marker));
      await engine.finalizeOnStartup();
      const rolled = await engine.rollback();
      assert.equal(rolled.ok, true);
      assert.equal(rolled.targets.length, 2);
      assert.equal(readFileSync(join(WORKSPACE, 'plugins', 'plugin-a', 'index.js'), 'utf8'), 'fallback-old\n');
      assert.equal(readFileSync(join(WORKSPACE, 'renamed-plugin', 'run.js'), 'utf8'), 'fallback-old\n');
      const calls = readFileSync(callsLog, 'utf8');
      assert.ok((calls.match(/-xzf/g) || []).length >= 2, 'stage 与 rollback 解压都应使用覆盖的 tar');
      assert.ok((calls.match(/-czf/g) || []).length >= 2, '安全副本打包应使用覆盖的 tar');
      await engine.ackPending();
    } finally {
      delete process.env.DSH_MAINTENANCE_TAR;
    }
  });

  // ---------------------------------------------------------------- PASS 摘要
  const okCount = checks.filter((item) => item.ok).length;
  assert.equal(okCount, checks.length);
  console.log('\n============================================');
  console.log(`PASS —— ${okCount}/${checks.length} 项断言全部通过`);
  console.log('覆盖：listSnapshots(缓存/refresh/FID覆盖) / preview(sidecar/无sidecar) / stage(下载大小校验、SHA-256、解压、暂存)');
  console.log('      diff(计数、字节、samples、targets、protected、warnings) / apply(安全副本、mirror 目录镜像、marker、ensureSelfRegistration)');
  console.log('      finalizeOnStartup(marker清理、lastRestore) / ackPending / rollback(safety保留) / discard / includeSelf=false 保护');
  console.log('      resolveSources 映射(精确 dest / basename 唯一 / 失败兜底) + 默认固定映射兜底');
  console.log('      跨平台(pathInside win32 / platform 注入 / mirror add-overwrite-delete-exclude / DSH_MAINTENANCE_TAR 覆盖)');
  console.log(`沙箱：${sandbox}`);
  console.log('============================================');

  if (process.env.DSH_RESTORE_TEST_KEEP !== '1') {
    rmSync(sandbox, { recursive: true, force: true });
    console.log('沙箱已清理（DSH_RESTORE_TEST_KEEP=1 可保留排查）');
  }
}

main().catch((error) => {
  console.error('\nFAIL:', error?.stack || error);
  console.error(`沙箱保留用于排查：${sandbox}`);
  process.exitCode = 1;
});
