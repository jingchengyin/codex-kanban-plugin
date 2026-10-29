#!/bin/sh
set -eu

taskboard_script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec /bin/sh "$taskboard_script_dir/start-mcp.sh" scripts/desktop-cli.mjs "$@"
