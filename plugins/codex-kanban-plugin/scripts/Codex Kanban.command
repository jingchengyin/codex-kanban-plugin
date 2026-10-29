#!/bin/sh
set -u

# 从脚本自己的位置启动，支持 Finder 双击和带空格的安装目录。
taskboard_script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
printf '%s\n' '对话看板 · 实时连接' '正在检查启动环境。Codex 已打开时，请按后续提示主动退出。'

# 复用插件的 Node 检测和共享启动流程，无需输入命令或安装 npm 依赖。
/bin/sh "$taskboard_script_dir/start-mcp.sh" scripts/start-live.mjs
taskboard_status=$?
if [ "$taskboard_status" -ne 0 ]; then
  printf '\n%s\n' '启动未完成，请查看上方提示。'
  if [ -t 0 ]; then
    printf '%s' '按回车关闭此启动器。'
    IFS= read -r taskboard_reply || true
  fi
fi
exit "$taskboard_status"
