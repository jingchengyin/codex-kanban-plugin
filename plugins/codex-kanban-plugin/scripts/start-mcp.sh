#!/bin/sh
set -eu

taskboard_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
taskboard_entry="$taskboard_root/${1:-runtime/server/index.mjs}"
[ "$#" -eq 0 ] || shift
taskboard_path_node=$(command -v node || true)

# 检查运行所需能力，探测输出不能混入 MCP 的标准输出。
taskboard_node_works() {
  [ -x "$1" ] && "$1" -e '
    const v = process.versions.node.split(".").map(Number);
    if (v[0] < 22 || (v[0] === 22 && v[1] < 13)) process.exit(1);
    require("node:sqlite");
    if (typeof WebSocket !== "function") process.exit(1);
  ' >/dev/null 2>&1
}

# 桌面端可能继承旧版 Node，继续查找 NVM 和 Homebrew 中的兼容版本。
for taskboard_node in \
  "$taskboard_path_node" \
  "${HOME:-}"/.nvm/versions/node/*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /opt/homebrew/opt/node@22/bin/node \
  /usr/local/opt/node@22/bin/node
do
  if taskboard_node_works "$taskboard_node"; then
    exec "$taskboard_node" "$taskboard_entry" "$@"
  fi
done

# 自动安装仅覆盖当前支持的 macOS，固定版本和官方校验和便于复现。
taskboard_node_version="22.23.4"
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'Automatic Node.js installation supports macOS only. Install Node.js >= 22.13 with node:sqlite to continue.' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64)
    taskboard_node_arch=arm64
    taskboard_node_sha256=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428
    ;;
  x86_64)
    taskboard_node_arch=x64
    taskboard_node_sha256=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819
    ;;
  *)
    printf '%s\n' 'Automatic Node.js installation supports Apple Silicon and Intel Macs only.' >&2
    exit 1
    ;;
esac

taskboard_codex_home=${CODEX_HOME:-${HOME:+$HOME/.codex}}
if [ -z "$taskboard_codex_home" ]; then
  printf '%s\n' 'Set HOME or CODEX_HOME so the plugin can cache Node.js.' >&2
  exit 1
fi
taskboard_runtime="$taskboard_codex_home/kanban/runtime"
taskboard_node_name="node-v$taskboard_node_version-darwin-$taskboard_node_arch"
taskboard_node="$taskboard_runtime/$taskboard_node_name/bin/node"
if taskboard_node_works "$taskboard_node"; then
  exec "$taskboard_node" "$taskboard_entry" "$@"
fi

# 先在同一文件系统的临时目录下载和验证，成功后才写入可复用缓存。
mkdir -p "$taskboard_runtime"
taskboard_temp=$(mktemp -d "$taskboard_runtime/.node-install.XXXXXX")
trap 'rm -rf "$taskboard_temp"' EXIT
trap 'exit 1' HUP INT TERM
taskboard_archive="$taskboard_node_name.tar.gz"
printf 'Installing Node.js %s for Codex Kanban; the first launch requires internet access.\n' "$taskboard_node_version" >&2
if ! curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 \
  --output "$taskboard_temp/$taskboard_archive" \
  "https://nodejs.org/dist/v$taskboard_node_version/$taskboard_archive" >&2; then
  printf '%s\n' 'Node.js download failed. Check your network and reopen the plugin to retry.' >&2
  exit 1
fi
if ! (cd "$taskboard_temp" && printf '%s  %s\n' "$taskboard_node_sha256" "$taskboard_archive" | shasum -a 256 -c -) >&2; then
  printf '%s\n' 'Node.js SHA-256 checksum verification failed. Reopen the plugin to retry.' >&2
  exit 1
fi
tar -xzf "$taskboard_temp/$taskboard_archive" -C "$taskboard_temp" "$taskboard_node_name/bin/node" >&2
if ! taskboard_node_works "$taskboard_temp/$taskboard_node_name/bin/node"; then
  printf '%s\n' 'The downloaded Node.js could not run with node:sqlite and WebSocket on this Mac.' >&2
  exit 1
fi
mkdir -p "$taskboard_runtime/$taskboard_node_name/bin"
mv -f "$taskboard_temp/$taskboard_node_name/bin/node" "$taskboard_node"
# exec 成功不会触发 EXIT trap，必须先清理下载文件。
rm -rf "$taskboard_temp"
trap - EXIT HUP INT TERM
exec "$taskboard_node" "$taskboard_entry" "$@"
