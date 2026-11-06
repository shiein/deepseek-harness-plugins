#!/usr/bin/env node
// @dsh-maintenance-tools-version 2
// 生成快照 sidecar 清单：dsh-snap-<ts>.manifest.json
//
// 内容：归档 sha256、文件数、总字节、按目录聚合、逐文件 [path,size]。
// 用途：还原预览只下载这个小文件（几十~一百多 KB），确认后再下载 12MB 的 tar。
//
// 用法：node make-sidecar.cjs <snapshot.tar.gz> <manifest.txt> <snapshot-name>
//   manifest.txt 每行来自 sync.sh 的 stat 输出："size mtime dest/path"
// 环境变量：DSH_SYNC_PARTIAL=1/0，SIDECAR_CREATED_AT（可选）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const [snapshotPath, manifestPath, snapName] = process.argv.slice(2);
if (!snapshotPath || !manifestPath || !snapName) {
  console.error('用法: node make-sidecar.cjs <snapshot.tar.gz> <manifest.txt> <snapshot-name>');
  process.exit(2);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function main() {
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    console.error(`读取 manifest 失败: ${error.message}`);
    process.exit(1);
  }
  const files = [];
  const entries = new Map();
  let totalBytes = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const match = line.match(/^(\d+) (\d+) (.*)$/);
    if (!match) continue;
    const size = Number(match[1]);
    const filePath = match[3];
    if (!filePath) continue;
    files.push([filePath, size]);
    totalBytes += size;
    const segments = filePath.split('/');
    let prefix;
    if (segments[0] === 'workspace') prefix = segments.slice(0, 2).join('/');
    else if (segments[0] === 'dsh-home') prefix = segments.slice(0, 2).join('/');
    else prefix = segments[0];
    const aggregate = entries.get(prefix) || { dest: prefix, files: 0, bytes: 0 };
    aggregate.files += 1;
    aggregate.bytes += size;
    entries.set(prefix, aggregate);
  }
  const archiveStat = fs.statSync(snapshotPath);
  sha256File(snapshotPath)
    .then((sha256) => {
      const sidecar = {
        schema: 1,
        name: snapName,
        created_at: process.env.SIDECAR_CREATED_AT || new Date().toISOString(),
        hostname: os.hostname(),
        archive_sha256: sha256,
        archive_size: archiveStat.size,
        file_count: files.length,
        total_bytes: totalBytes,
        partial: process.env.DSH_SYNC_PARTIAL === '1',
        entries: [...entries.values()].sort((a, b) => a.dest.localeCompare(b.dest)),
        files,
      };
      const outPath = snapshotPath.replace(/\.tar\.gz$/, '') + '.manifest.json';
      fs.writeFileSync(outPath, `${JSON.stringify(sidecar)}\n`, 'utf8');
      process.stdout.write(
        JSON.stringify({
          ok: true,
          path: outPath,
          bytes: fs.statSync(outPath).size,
          file_count: files.length,
          archive_sha256: sha256,
          entries: sidecar.entries.length,
        }),
      );
    })
    .catch((error) => {
      console.error(`计算 sha256 失败: ${error.message}`);
      process.exit(1);
    });
}

main();
