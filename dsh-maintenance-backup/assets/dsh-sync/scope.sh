#!/bin/bash
# @dsh-maintenance-tools-version 2
# 网盘备份维护插件：备份范围报告（config.sh 是唯一事实来源）
#
# 输出：一行 JSON 到 stdout，包含固定条目 + 自动发现的 link: 插件、可读性、文件数、大小、
# 排除项与说明。插件（DSH 主进程）调用它来渲染「备份范围」面板，因此与 sync.sh 完全一致。
#
# 用法：
#   bash ~/.dsh-sync/scope.sh
#   环境变量：
#     DSH_SYNC_DISABLED_FILE   JSON 数组文件，元素为被 UI 禁用的本地路径
#     DSH_SYNC_KEEP            覆盖保留份数（展示用）

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SELF_DIR/config.sh"

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

KEEP="${DSH_SYNC_KEEP:-$KEEP}"

# ---------- 读取被禁用的条目 ----------
DISABLED_SRCS=()
if [ -n "${DSH_SYNC_DISABLED_FILE:-}" ] && [ -f "${DSH_SYNC_DISABLED_FILE}" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && DISABLED_SRCS+=("$line")
  done < <(node -e '
    const fs = require("fs");
    try {
      const list = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const item of Array.isArray(list) ? list : []) {
        if (typeof item === "string" && item) console.log(item);
      }
    } catch {}
  ' "$DSH_SYNC_DISABLED_FILE" 2>/dev/null)
fi

is_disabled() {
  local target="$1" item
  for item in "${DISABLED_SRCS[@]:-}"; do
    [ "$item" = "$target" ] && return 0
  done
  return 1
}

# ---------- 合并条目：固定 + link: 自动发现 ----------
ALL_ENTRIES=()
DISCOVERED=()
add_entry() {  # $1=本地路径 $2=包内路径 $3=是否自动发现(1/0)
  local src="$1" dest="$2" disc="${3:-0}" e esrc
  if [ "${#ALL_ENTRIES[@]}" -gt 0 ]; then
    for e in "${ALL_ENTRIES[@]}"; do
      esrc="${e%%|*}"
      [ "$esrc" = "$src" ] && return 0
      case "$src/" in "$esrc"/*) return 0 ;; esac
    done
  fi
  ALL_ENTRIES+=("$src|$dest")
  [ "$disc" = "1" ] && DISCOVERED+=("$src")
}

for entry in "${SYNC_ENTRIES[@]}"; do
  add_entry "${entry%%|*}" "${entry#*|}" 0
done

if [ -f "$SELF_DIR/discover-link-entries.cjs" ] && command -v node >/dev/null 2>&1; then
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    add_entry "$target" "workspace/$(basename "$target")" 1
  done < <(node "$SELF_DIR/discover-link-entries.cjs" 2>/dev/null)
fi

# ---------- 生成条目清单，交给 node 采集统计 ----------
TMP="$(mktemp "${TMPDIR:-/tmp}/dsh-scope.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

for entry in "${ALL_ENTRIES[@]:-}"; do
  src="${entry%%|*}"
  dest="${entry#*|}"
  disc=0
  if [ "${#DISCOVERED[@]}" -gt 0 ]; then
    for d in "${DISCOVERED[@]}"; do
      [ "$d" = "$src" ] && disc=1
    done
  fi
  disabled=0
  is_disabled "$src" && disabled=1
  printf '%s\t%s\t%s\t%s\n' "$src" "$dest" "$disc" "$disabled" >>"$TMP"
done

# PRUNE_ABS 用换行传给 node（用于统计时排除）
PRUNE_LIST=""
if [ "${#PRUNE_ABS[@]}" -gt 0 ]; then PRUNE_LIST="$(printf '%s\n' "${PRUNE_ABS[@]}")"; fi

DSH_SYNC_KEEP="$KEEP" \
DSH_SYNC_DSH_FID="$QUARK_DSH_FID" \
DSH_SYNC_ARCHIVE_FID="$QUARK_ARCHIVE_FID" \
DSH_SYNC_PRUNE_ABS="$PRUNE_LIST" \
DSH_SYNC_EXCLUDES="$(printf '%s\n' "${EXCLUDES[@]}")" \
node "$SELF_DIR/scope-report.cjs" "$TMP"
