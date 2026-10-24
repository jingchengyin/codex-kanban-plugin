#!/bin/sh
set -eu

taskboard_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
taskboard_entry="$taskboard_root/${1:-runtime/server/index.mjs}"
taskboard_path_node=$(command -v node || true)

# Desktop apps may inherit an older system Node instead of the shell's NVM Node.
# Probe quietly: stdout is reserved for the MCP protocol.
for taskboard_node in \
  "$taskboard_path_node" \
  "${HOME:-}"/.nvm/versions/node/*/bin/node \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  /opt/homebrew/opt/node@22/bin/node \
  /usr/local/opt/node@22/bin/node
do
  [ -x "$taskboard_node" ] || continue
  if "$taskboard_node" -e '
    const v = process.versions.node.split(".").map(Number);
    if (v[0] < 22 || (v[0] === 22 && v[1] < 13)) process.exit(1);
    require("node:sqlite");
    if (typeof WebSocket !== "function") process.exit(1);
  ' >/dev/null 2>&1; then
    exec "$taskboard_node" "$taskboard_entry"
  fi
done

printf '%s\n' 'Codex Taskboard requires Node.js >= 22.13 with node:sqlite. Install a compatible Node in PATH, NVM, or Homebrew, then restart the MCP connection.' >&2
exit 1
