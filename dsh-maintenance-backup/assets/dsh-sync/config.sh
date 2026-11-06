#!/bin/bash
# DSH 配置与插件自动同步 —— 配置项
# 修改本文件即可调整同步范围，无需改动 sync.sh

# ---- 夸克网盘目录 FID ----
QUARK_DSH_FID="210e76226f274d749cfc712725c72c68"       # 夸克网盘/dsh
QUARK_ARCHIVE_FID="e3462aa31eb849dca82a96d8153dc41e"   # 夸克网盘/dsh/_archive

# ---- 滚动保留份数（dsh/ 下最多保留这么多快照，超出移入 _archive）----
KEEP=5

# ---- Quark Skill CLI ----
SKILL_DIR="$HOME/.dsh/skills/quarkclouddrive"
CLI="$SKILL_DIR/scripts/quark-drive.cjs"

# ---- 同步条目：本地绝对路径|压缩包内路径 ----
# 注意：~/.dsh/.credentials.yaml（API 密钥）按约定不同步
SYNC_ENTRIES=(
  "$HOME/.dsh/profiles|dsh-home/profiles"
  "$HOME/.dsh/skills|dsh-home/skills"
  "$HOME/.dsh/agent-assets|dsh-home/agent-assets"
  "$HOME/.dsh/plugins|dsh-home/plugins"
  "$HOME/.dsh/.agent-presets|dsh-home/.agent-presets"
  "$HOME/.dsh/llm-deepseek|dsh-home/llm-deepseek"
  "$HOME/.dsh/dsh-claude-style|dsh-home/dsh-claude-style"
  "$HOME/Documents/workspace/dsh/plugins|workspace/plugins"
  "$HOME/Documents/workspace/dsh-page-preview|workspace/dsh-page-preview"
  "$HOME/Documents/workspace/overview/dsh-agent-usage|workspace/dsh-agent-usage"
  "$HOME/.dsh-sync|dsh-sync"
)

# ---- 运行时状态目录（整体跳过，避免运行时写入反复触发同步）----
# 夸克 CLI 会把上传任务记录写在自己的技能目录下，必须排除，否则每次上传都会
# 改变文件指纹，形成「上传→触发→再上传」的自我循环
PRUNE_ABS=(
  "$HOME/.dsh/skills/quarkclouddrive/deepseek"
  "$HOME/.dsh/skills/quarkclouddrive/browse"
  "$HOME/.dsh-sync/state"
  "$HOME/.dsh-sync/logs"
)

# ---- 自动模式下若快照不完整（因权限缺失）是否仍上传 ----
# 0 = 不上传（默认，保证云端不出现残缺备份）
# 1 = 仍然上传，并在包内写入 WARNING-PARTIAL-SNAPSHOT.txt
ALLOW_PARTIAL_IN_AUTO=0

# ---- 排除规则（目录名/文件名，rsync 与指纹计算共用）----
EXCLUDES=(
  node_modules
  .git
  .DS_Store
  .turbo
  "*.log"
  "*.tmp"
)

# ---- 变更检测轮询间隔由 launchd 的 StartInterval 控制（默认 600 秒）----
# ---- 安装自检节流（分钟）：至少间隔这么久才向夸克拉取一次版本信息 ----
INSTALL_CHECK_INTERVAL_MIN=1440

# ---- 本地日志保留大小（KB），超过则轮转 ----
LOG_MAX_KB=1024
