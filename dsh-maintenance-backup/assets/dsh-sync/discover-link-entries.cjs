#!/usr/bin/env node
// @dsh-maintenance-tools-version 2
// 从 ~/.dsh/profiles/*/package.json 的 dependencies 中提取本地 link: 插件包路径
// 输出：每行一个绝对路径（已去重）
// 用途：让新安装的本地插件自动纳入同步范围，无需手工维护 config.sh

const fs = require("fs");
const path = require("path");
const os = require("os");

const home = os.homedir();
const profilesDir = path.join(home, ".dsh", "profiles");
const found = new Set();

let dirs = [];
try {
  dirs = fs
    .readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
} catch {
  process.exit(0);
}

for (const dir of dirs) {
  const pkgPath = path.join(profilesDir, dir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    continue;
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = pkg[field] || {};
    for (const spec of Object.values(deps)) {
      if (typeof spec !== "string" || !spec.startsWith("link:")) continue;
      let target = spec.slice("link:".length).trim();
      if (!target) continue;
      if (!path.isAbsolute(target)) target = path.resolve(profilesDir, dir, target);
      if (fs.existsSync(target)) found.add(target);
    }
  }
}

process.stdout.write([...found].join("\n"));
