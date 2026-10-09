#!/bin/sh
# gustaf-device: lets an agent CLI (Claude Code, Codex, Cursor) drive the simulator or emulator through the Gustaf app.
# It sends its arguments to the app's local-only bridge (127.0.0.1, per-chat token in GUSTAF_DEVICE_TOKEN) and prints the
# answer. Gustaf puts this file on the agent's PATH only while "Agent device access" is on. Needs curl.
url="${GUSTAF_DEVICE_URL:-}"
token="${GUSTAF_DEVICE_TOKEN:-}"
if [ -z "$url" ] || [ -z "$token" ]; then
  echo "gustaf-device: not available here. Turn on Settings > Computer use > Devices > Agent device access in Gustaf and start a new message." >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "gustaf-device: curl is required." >&2
  exit 2
fi
# Every argument becomes one form field "a=<value>" (order kept, any characters allowed).
n=$#
while [ "$n" -gt 0 ]; do
  set -- "$@" --data-urlencode "a=$1"
  shift
  n=$((n - 1))
done
out=$(curl -sS --max-time 700 -X POST -H "Authorization: Bearer $token" -w '\n%{http_code}' "$@" "$url") || {
  echo "gustaf-device: cannot reach Gustaf. Is the app running? (A sandbox without network access, such as Codex's workspace-write sandbox, blocks this command.)" >&2
  exit 3
}
code=$(printf '%s\n' "$out" | tail -n 1)
body=$(printf '%s\n' "$out" | sed '$d')
if [ "$code" = "200" ]; then
  printf '%s\n' "$body"
else
  printf '%s\n' "$body" >&2
  exit 1
fi
