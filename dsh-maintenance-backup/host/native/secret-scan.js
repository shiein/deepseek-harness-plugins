/**
 * 原生备份引擎 —— 敏感信息扫描（替代 sync.sh 里的 grep 逻辑）。
 *
 * 规则（与旧 sync.sh 一致）：
 * - 真实令牌格式：`sk-[A-Za-z0-9]{20,}`、`AKIA[0-9A-Z]{16}`、`-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----`；
 * - 测试路径（test/tests/__tests__/fixtures 目录，或 *.spec.* / *.test.* / test.* 文件）只告警；
 * - 二进制文件与超大文件跳过（避免误报与内存占用）；
 * - 只返回路径，**绝不回显密钥原文**（错误消息也不能带命中的文本）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8000;

const SECRET_RE = /sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/;
const TEST_PATH_RE =
  /(^|\/)(test|tests|__tests__|fixtures)(\/|$)|\.(spec|test)\.[A-Za-z0-9]+$|(^|\/)test\.[^/]+$/;

/** @param {Buffer} buffer */
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * 扫描暂存目录中的文件内容。
 *
 * @param {string} stageDir
 * @returns {{ hits: string[], testHits: string[], scanned: number }}
 */
export function scanSecrets(stageDir) {
  /** @type {string[]} */
  const hits = [];
  /** @type {string[]} */
  const testHits = [];
  let scanned = 0;
  const root = String(stageDir || '');
  if (!root) return { hits, testHits, scanned };
  /** @type {Array<{dir:string, rel:string}>} */
  const stack = [{ dir: root, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let list;
    try {
      list = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of list) {
      if (item.isSymbolicLink()) continue;
      const rel = current.rel ? `${current.rel}/${item.name}` : item.name;
      const abs = join(current.dir, item.name);
      if (item.isDirectory()) {
        stack.push({ dir: abs, rel });
        continue;
      }
      if (!item.isFile()) continue;
      let info;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.size > MAX_SCAN_BYTES) continue;
      let buffer;
      try {
        buffer = readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buffer)) continue;
      scanned += 1;
      if (!SECRET_RE.test(buffer.toString('utf8'))) continue;
      if (TEST_PATH_RE.test(rel)) testHits.push(rel);
      else hits.push(rel);
    }
  }
  hits.sort();
  testHits.sort();
  return { hits, testHits, scanned };
}
