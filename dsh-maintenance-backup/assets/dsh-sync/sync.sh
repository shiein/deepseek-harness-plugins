#!/bin/bash
# @dsh-maintenance-tools-version 2
# DSH 配置与插件 —— 全量快照同步到夸克网盘
#
# 用法：
#   ./sync.sh            检测到变更才同步（自动化调用方式）
#   ./sync.sh --force    强制同步，忽略变更指纹
#   ./sync.sh --build    只打包不下载上传（本地排查用）
#
# 设计：
#   1. 对同步范围内的文件生成 "大小+修改时间+路径" 指纹，与上次对比，无变化直接退出
#   2. 有变化则打包为 dsh-snap-<日期_时间>.tar.gz（全量）
#   3. 上传到 夸克网盘/dsh
#   4. dsh/ 下保留最新 KEEP(5) 份，更早的移入 夸克网盘/dsh/_archive
#      （夸克 Skill CLI 无删除文件能力，因此用归档代替删除，归档目录需在 App 内手动清空）

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SELF_DIR/config.sh"

export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 允许用环境变量临时覆盖保留份数（便于验证滚动逻辑）
KEEP="${DSH_SYNC_KEEP:-$KEEP}"

# ---------- 合并同步条目：config.sh 固定条目 + profile 中 link: 的本地插件 ----------
ALL_ENTRIES=("${SYNC_ENTRIES[@]}")
add_entry() {  # $1=本地路径 $2=包内路径
  local src="$1" dest="$2" e esrc
  [ -d "$src" ] || return 0
  for e in "${ALL_ENTRIES[@]}"; do
    esrc="${e%%|*}"
    # 已存在，或已被父级条目覆盖（避免重复打包）
    [ "$esrc" = "$src" ] && return 0
    case "$src/" in "$esrc"/*) return 0 ;; esac
  done
  ALL_ENTRIES+=("$src|$dest")
}
if [ -f "$SELF_DIR/discover-link-entries.cjs" ] && command -v node >/dev/null 2>&1; then
  while IFS= read -r target; do
    [ -n "$target" ] || continue
    add_entry "$target" "workspace/$(basename "$target")"
  done < <(node "$SELF_DIR/discover-link-entries.cjs" 2>/dev/null)
fi

STATE_DIR="$SELF_DIR/state"
LOG_DIR="$SELF_DIR/logs"
LOG="$LOG_DIR/sync.log"
MANIFEST="$STATE_DIR/manifest.txt"
LAST_HASH_FILE="$STATE_DIR/last.hash"
INSTALL_STAMP="$STATE_DIR/last-install-check"

mkdir -p "$STATE_DIR" "$LOG_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }
die() { log "ERROR: $*"; log "STAGE=error $*"; log "--- 同步失败 ---"; exit 1; }

# ---------- 应用维护面板里禁用的条目 ----------
if [ -n "${DSH_SYNC_DISABLED_FILE:-}" ] && [ -f "${DSH_SYNC_DISABLED_FILE}" ]; then
  DISABLED_SRCS=()
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
  ' "${DSH_SYNC_DISABLED_FILE}" 2>/dev/null)
  if [ "${#DISABLED_SRCS[@]}" -gt 0 ]; then
    FILTERED_ENTRIES=()
    for entry in "${ALL_ENTRIES[@]}"; do
      esrc="${entry%%|*}"
      skip=0
      for d in "${DISABLED_SRCS[@]}"; do [ "$d" = "$esrc" ] && skip=1; done
      [ "$skip" = "0" ] && FILTERED_ENTRIES+=("$entry")
    done
    ALL_ENTRIES=("${FILTERED_ENTRIES[@]}")
    log "已按面板设置禁用 ${#DISABLED_SRCS[@]} 个备份条目"
  fi
fi

# 日志轮转
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt $((LOG_MAX_KB * 1024)) ]; then
  mv -f "$LOG" "$LOG.1" 2>/dev/null
fi

MODE="auto"
case "${1:-}" in
  --force) MODE="force" ;;
  --build) MODE="build" ;;
  "") MODE="auto" ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
esac

# ---------- 单实例锁 ----------
LOCK="$STATE_DIR/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # 超过 60 分钟的陈旧锁视为残留
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
    rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || { log "无法获取锁，跳过本次"; exit 0; }
  else
    log "已有同步进程在运行，跳过本次"
    exit 0
  fi
fi
STAGE=""
cleanup() { rm -rf "$LOCK"; [ -n "$STAGE" ] && rm -rf "$STAGE"; }
trap cleanup EXIT INT TERM

log "=== 开始检查 (mode=$MODE) ==="
log "STAGE=start"

# ---------- 变更指纹 ----------
# 每个条目独立的 prune 表达式：通用忽略项 + 该条目下的运行时状态目录
entry_find_expr() {  # $1=条目源目录，输出 find 的 prune 子表达式参数
  local src="$1" p
  printf '%s\0' -name node_modules -o -name .git -o -name .DS_Store -o -name .turbo \
    -o -name '*.log' -o -name '*.tmp'
  for p in "${PRUNE_ABS[@]}"; do
    case "$p" in
      "$src"/*) printf '%s\0' -o -path "./${p#"$src"/}" ;;
    esac
  done
}

build_manifest() {
  local entry src dest
  : >"$MANIFEST.tmp"
  for entry in "${ALL_ENTRIES[@]}"; do
    src="${entry%%|*}"
    dest="${entry#*|}"
    [ -d "$src" ] || { log "WARN: 跳过不存在的目录 $src"; continue; }
    (
      cd "$src" || exit 0
      mapfile_expr=()
      while IFS= read -r -d '' tok; do mapfile_expr+=("$tok"); done < <(entry_find_expr "$src")
      find . \( "${mapfile_expr[@]}" \) -prune -o -type f -print0 \
        | xargs -0 stat -f '%z %m %N' 2>/dev/null \
        | sed "s# \./# ${dest}/#"
    ) >>"$MANIFEST.tmp"
  done
  LC_ALL=C sort "$MANIFEST.tmp" >"$MANIFEST"
  rm -f "$MANIFEST.tmp"
  shasum -a 256 "$MANIFEST" | awk '{print $1}'
}

CUR_HASH="$(build_manifest)"
FILE_COUNT="$(wc -l <"$MANIFEST" | tr -d ' ')"
LAST_HASH="$(cat "$LAST_HASH_FILE" 2>/dev/null || echo '')"
log "指纹 ${CUR_HASH:0:16}… 文件数 $FILE_COUNT"
log "STAGE=fingerprint"

if [ "$MODE" = "auto" ] && [ -n "$LAST_HASH" ] && [ "$CUR_HASH" = "$LAST_HASH" ]; then
  log "无变更，跳过同步"
  log "STAGE=skip 无变更"
  exit 0
fi

# ---------- 安装自检（节流）----------
need_check=0
if [ "$MODE" = "force" ] || [ ! -f "$INSTALL_STAMP" ]; then
  need_check=1
elif [ -n "$(find "$INSTALL_STAMP" -maxdepth 0 -mmin +"$INSTALL_CHECK_INTERVAL_MIN" 2>/dev/null)" ]; then
  need_check=1
fi
if [ "$need_check" = "1" ] && [ -f "$SKILL_DIR/scripts/install.sh" ]; then
  log "执行 Skill 安装自检…"
  if ( cd "$SKILL_DIR" && bash scripts/install.sh >>"$LOG" 2>&1 ); then
    touch "$INSTALL_STAMP"
    log "安装自检通过"
  else
    log "WARN: 安装自检失败，继续使用现有版本同步"
  fi
fi

# ---------- 打包 ----------
log "STAGE=pack"
STAGE="$(mktemp -d "$STATE_DIR/stage.XXXXXX")"
mkdir -p "$STAGE/dsh-home" "$STAGE/workspace"

RSYNC_BASE_EXCLUDES=()
for pat in "${EXCLUDES[@]}"; do RSYNC_BASE_EXCLUDES+=(--exclude "$pat"); done

TOTAL_BYTES=0
SKIPPED=()
for entry in "${ALL_ENTRIES[@]}"; do
  src="${entry%%|*}"
  dest="${entry#*|}"
  [ -d "$src" ] || continue
  # macOS 隐私保护（TCC）下 launchd 进程可能无法读取 ~/Documents 等受保护目录
  if ! ls "$src" >/dev/null 2>&1; then
    SKIPPED+=("$src")
    log "WARN: 无读取权限，跳过 $src"
    continue
  fi
  mkdir -p "$STAGE/$(dirname "$dest")"
  # 条目级排除：通用忽略项 + 运行时状态目录
  RSYNC_ARGS=("${RSYNC_BASE_EXCLUDES[@]}")
  for p in "${PRUNE_ABS[@]}"; do
    case "$p" in
      "$src"/*) RSYNC_ARGS+=(--exclude "/${p#"$src"/}") ;;
    esac
  done
  if ! rsync -a "${RSYNC_ARGS[@]}" "$src/" "$STAGE/$dest/" 2>>"$LOG"; then
    SKIPPED+=("$src")
    log "WARN: 复制失败，跳过 $src"
    continue
  fi
  sz=$(du -sk "$STAGE/$dest" 2>/dev/null | awk '{print $1}')
  TOTAL_BYTES=$((TOTAL_BYTES + ${sz:-0}))
  log "  已加入 $dest ($(( ${sz:-0} / 1024 )) MB)"
done

PARTIAL="false"
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  PARTIAL="true"
  log "WARN: 本次有 ${#SKIPPED[@]} 个目录因权限被跳过，快照不完整"
  {
    echo "本快照为【不完整快照】，以下目录在同步运行环境中无读取权限，未被包含："
    printf -- '- %s\n' "${SKIPPED[@]}"
    echo ""
    echo "常见原因：launchd 定时任务受 macOS 隐私保护限制，无法读取 ~/Documents。"
    echo "解决办法：给 /bin/bash 授予「完全磁盘访问权限」，详见 ~/.dsh-sync/README.md。"
  } >"$STAGE/WARNING-PARTIAL-SNAPSHOT.txt"
fi

# 自动模式（launchd）下默认不提交残缺快照，宁可等权限到位或人工干预
if [ "$PARTIAL" = "true" ] && [ "$MODE" = "auto" ] && [ "${ALLOW_PARTIAL_IN_AUTO:-0}" != "1" ]; then
  log "WARN: 自动运行缺少目录权限，本次不上传不完整快照（已跳过 ${#SKIPPED[@]} 个目录）"
  log "      处理办法：1) 给 /bin/bash 授予「完全磁盘访问权限」；或 2) 在终端执行 bash $SELF_DIR/sync.sh --force"
  exit 0
fi

log "STAGE=scan"
# ---------- 敏感信息扫描 ----------
# 匹配真实令牌格式与私钥头。非测试代码命中 → 中止上传；
# 测试代码/fixtures 下的命中视为假样本，仅记录告警（如验证脱敏逻辑的用例）。
SCAN_RE='sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----'
TEST_PATH_RE='/(test|tests|__tests__|fixtures)/|\.(spec|test)\.[a-zA-Z]+$'
SCAN_ALL="$STATE_DIR/secret-scan.all.txt"
SCAN_LIST="$STATE_DIR/secret-scan.txt"

grep -rIlE "$SCAN_RE" "$STAGE" 2>/dev/null \
  | sed "s#$STAGE/##" | LC_ALL=C sort -u >"$SCAN_ALL" || true

grep -vE "$TEST_PATH_RE" "$SCAN_ALL" >"$SCAN_LIST" 2>/dev/null || true
TEST_HITS=$(grep -E "$TEST_PATH_RE" "$SCAN_ALL" 2>/dev/null | wc -l | tr -d ' ')
SECRET_HITS=$(wc -l <"$SCAN_LIST" | tr -d ' ')

if [ "${TEST_HITS:-0}" -gt 0 ]; then
  log "提示: $TEST_HITS 个测试文件含假密钥样本，未阻断（明细见 state/secret-scan.all.txt）"
fi

if [ "${SECRET_HITS:-0}" -gt 0 ]; then
  log "ERROR: 检测到 $SECRET_HITS 个疑似含真实密钥/私钥的非测试文件，已中止上传（清单见 state/secret-scan.txt）"
  die "敏感信息扫描未通过"
fi
log "敏感信息扫描通过"

# ---------- 清单与恢复说明 ----------
SNAP_STAMP="$(date '+%Y-%m-%d_%H%M%S')"
SNAP_NAME="dsh-snap-${SNAP_STAMP}.tar.gz"

cat >"$STAGE/MANIFEST.json" <<EOF
{
  "name": "$SNAP_NAME",
  "created_at": "$(date '+%Y-%m-%dT%H:%M:%S%z')",
  "hostname": "$(hostname)",
  "file_count": $FILE_COUNT,
  "approx_size_mb": $(echo "$TOTAL_BYTES" | awk '{printf "%.1f", $1/1024}'),
  "partial": $PARTIAL,
  "contents": ["dsh-home/", "workspace/", "RESTORE.md", "MANIFEST.json"],
  "excludes": ["node_modules", ".git", ".DS_Store", "*.log", "*.tmp", ".credentials.yaml"],
  "note": "DSH 配置与插件全量快照；API 密钥未包含在快照内"
}
EOF

cat >"$STAGE/RESTORE.md" <<'EOF'
# DSH 配置与插件快照 —— 恢复说明

本压缩包由 `~/.dsh-sync/sync.sh` 自动生成，包含 DSH 的配置、技能与插件源码
（不含 node_modules、.git 与 API 密钥）。

## 目录结构

| 包内路径 | 对应本机位置 |
|---|---|
| `dsh-home/` | `~/.dsh/`（profiles、skills、plugins、.agent-presets 等） |
| `workspace/` | `~/Documents/workspace/` 下的插件工程（plugins、dsh-page-preview、dsh-agent-usage） |
| `dsh-sync/` | `~/.dsh-sync/`（同步脚本与配置，不含 state/logs） |
| `MANIFEST.json` | 快照元信息 |

## 恢复步骤（新电脑）

```bash
# 1. 解压
mkdir -p /tmp/dsh-restore && tar -xzf dsh-snap-*.tar.gz -C /tmp/dsh-restore

# 2. 还原 ~/.dsh（先备份原有目录）
[ -d ~/.dsh ] && mv ~/.dsh ~/.dsh.bak.$(date +%s)
mkdir -p ~/.dsh && cp -R /tmp/dsh-restore/dsh-home/. ~/.dsh/

# 3. 还原插件工程
mkdir -p ~/Documents/workspace
cp -R /tmp/dsh-restore/workspace/. ~/Documents/workspace/

# 4. 重装依赖（node_modules 不在快照内）
cd ~/.dsh/profiles/desktop && pnpm install
for d in ~/Documents/workspace/dsh/plugins/*/ ~/Documents/workspace/dsh-page-preview/; do
  [ -f "$d/package.json" ] && (cd "$d" && pnpm install)
done

# 5. 手动补齐密钥：新建 ~/.dsh/.credentials.yaml（快照中不含）
# 6. 还原同步脚本并重建定时任务
cp -R /tmp/dsh-restore/dsh-sync ~/.dsh-sync
# 把 launchd plist 里的 /Users/<旧用户名>/ 改成新机器路径后加载：
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aesc.dsh-sync.plist
# 7. 重启 DSH，确认插件列表与配置一致
```

## 注意事项

- 配置中若含绝对路径（如 `link:/Users/<用户名>/...`），换机后需改成新机器的路径。
- 本机 `~/.dsh-sync/` 下的同步脚本不在快照内，如需自动化请一并复制。
EOF

# ---------- 生成压缩包 ----------
SNAP_PATH="$STATE_DIR/$SNAP_NAME"
tar -czf "$SNAP_PATH" -C "$STAGE" . || die "打包压缩失败"
SNAP_MB=$(du -sm "$SNAP_PATH" | awk '{print $1}')
log "快照打包完成: $SNAP_NAME (${SNAP_MB} MB)"

# sidecar 小清单：还原预览只下载它，避免每次都拉 12MB
SIDECAR_PATH=""
if command -v node >/dev/null 2>&1; then
  if node "$SELF_DIR/make-sidecar.cjs" "$SNAP_PATH" "$MANIFEST" "$SNAP_NAME" >/dev/null 2>>"$LOG"; then
    SIDECAR_PATH="${SNAP_PATH%.tar.gz}.manifest.json"
    if [ -f "$SIDECAR_PATH" ]; then
      log "sidecar 清单生成: $(basename "$SIDECAR_PATH") ($(wc -c <"$SIDECAR_PATH" | tr -d ' ') 字节)"
    else
      SIDECAR_PATH=""
    fi
  else
    log "WARN: sidecar 清单生成失败，本次仅上传完整快照"
  fi
fi

if [ "$MODE" = "build" ]; then
  log "构建模式：跳过上传，快照保留在 $SNAP_PATH"
  echo "$SNAP_PATH"
  exit 0
fi

# ---------- 上传 ----------
log "STAGE=upload"
log "上传到夸克网盘/dsh …"
UPLOAD_OUT="$(node "$CLI" upload "$SNAP_PATH" \
  --parent-fid "$QUARK_DSH_FID" \
  --session-input "DSH 配置与插件自动同步" \
  --session-id "$(date +%s)-$RANDOM" 2>&1)"

if ! printf '%s' "$UPLOAD_OUT" | grep -q '"type":"result"'; then
  printf '%s\n' "$UPLOAD_OUT" | tail -20 >>"$LOG"
  die "上传未返回结果"
fi
if ! printf '%s' "$UPLOAD_OUT" | grep -q '"code":0'; then
  printf '%s\n' "$UPLOAD_OUT" | tail -20 >>"$LOG"
  die "上传失败"
fi
log "上传成功: $SNAP_NAME"

# 上传 sidecar 清单（失败不影响主备份）
if [ -n "${SIDECAR_PATH:-}" ] && [ -f "$SIDECAR_PATH" ]; then
  SIDECAR_OUT="$(node "$CLI" upload "$SIDECAR_PATH" \
    --parent-fid "$QUARK_DSH_FID" \
    --session-input "DSH 配置与插件自动同步" \
    --session-id "$(date +%s)-$RANDOM" 2>&1)"
  if printf '%s' "$SIDECAR_OUT" | grep -q '"code":0'; then
    log "sidecar 清单已上传: $(basename "$SIDECAR_PATH")"
  else
    log "WARN: sidecar 清单上传失败（不影响本次备份）"
  fi
fi


log "STAGE=archive"
# ---------- 滚动保留：超出 KEEP 份移入 _archive ----------
BROWSE_OUT="$STATE_DIR/browse.out"
BROWSE_TASK="$STATE_DIR/browse-task"
mkdir -p "$BROWSE_TASK"

if node "$CLI" browse --parent-fid "$QUARK_DSH_FID" --all --page-size 100 \
     --task-dir "$BROWSE_TASK" \
     --session-input "DSH 配置与插件自动同步" \
     --session-id "$(date +%s)-$RANDOM" >"$BROWSE_OUT" 2>&1 \
   && grep -q '"code":0' "$BROWSE_OUT"; then

  SNAP_TOTAL=$(node "$SELF_DIR/parse-browse.cjs" "$BROWSE_OUT" snapshots 2>/dev/null | wc -l | tr -d ' ')
  log "dsh/ 下现有快照 $SNAP_TOTAL 份（保留 $KEEP 份；sidecar 不占配额）"

  if [ "${SNAP_TOTAL:-0}" -gt "$KEEP" ]; then
    PRUNE_FIDS=$(node "$SELF_DIR/parse-browse.cjs" "$BROWSE_OUT" prune "$KEEP" 2>/dev/null)
    PRUNE_COUNT=$(printf '%s\n' "$PRUNE_FIDS" | grep -c . || true)
    if [ "${PRUNE_COUNT:-0}" -gt 0 ]; then
      # shellcheck disable=SC2086
      if node "$CLI" move $PRUNE_FIDS --target-fid "$QUARK_ARCHIVE_FID" \
           --session-input "DSH 配置与插件自动同步" \
           --session-id "$(date +%s)-$RANDOM" >>"$LOG" 2>&1; then
        log "已归档 $PRUNE_COUNT 个对象（旧快照 + 对应 sidecar）到 dsh/_archive"
      else
        log "WARN: 归档旧快照失败（不影响本次同步）"
      fi
    fi
  fi
else
  tail -3 "$BROWSE_OUT" >>"$LOG" 2>/dev/null
  log "WARN: 列目录失败，跳过滚动清理"
fi
rm -rf "$BROWSE_TASK" "$BROWSE_OUT"

# ---------- 提交 ----------
echo "$CUR_HASH" >"$LAST_HASH_FILE"
rm -f "$SNAP_PATH"
[ -n "${SIDECAR_PATH:-}" ] && rm -f "$SIDECAR_PATH"
rm -rf "$STATE_DIR"/stage.* 2>/dev/null
log "STAGE=done"
log "=== 同步完成: $SNAP_NAME ==="
