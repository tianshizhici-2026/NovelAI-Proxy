#!/usr/bin/env bash
set -eu

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_dir"
umask 077
mkdir -p .run
exec 9>.run/start.lock
flock -n 9 || exit 0

# Also recognise an existing service that was started without this script.
if awk '$2 ~ /:1776$/ && $4 == "0A" { found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6; then
  exit 0
fi
if [[ -f .run/service.pid ]]; then
  read -r service_pid < .run/service.pid || true
  if [[ ${service_pid:-} =~ ^[0-9]+$ ]] && kill -0 "$service_pid" 2>/dev/null &&
    [[ "$(readlink "/proc/$service_pid/cwd" 2>/dev/null || true)" == "$project_dir" ]] &&
    [[ "$(tr '\0' ' ' < "/proc/$service_pid/cmdline" 2>/dev/null || true)" == *server/index.ts* ]]; then
    exit 0
  fi
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]] || ! "$node_bin" --use-env-proxy -e '' >/dev/null 2>&1; then
  echo 'NovelAI: 请安装 Node.js 24.5 或更新版本，并加入 PATH。' >&2
  exit 1
fi
[[ -x "$node_bin" && -f dist/index.html && -d node_modules ]] || {
  echo 'NovelAI: 缺少 Node.js、依赖或构建文件，无法启动。' >&2
  exit 1
}

PORT=6006 HOST=0.0.0.0 setsid nohup "$node_bin" --use-env-proxy --import tsx server/index.ts \
  >> /tmp/novelai-proxy-6006.log 2>&1 < /dev/null 9>&- &
printf '%s\n' "$!" > .run/service.pid
