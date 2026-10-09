#!/bin/sh
# gustaf-device / gustaf-agent: lets an agent CLI (Claude Code, Codex, Cursor) use Gustaf from its shell. The same script is
# installed under both names; its own name picks the command. It sends its arguments to the app's local-only bridge
# (127.0.0.1, per-chat token in GUSTAF_BRIDGE_TOKEN) and prints the answer. Gustaf puts it on the agent's PATH only while
# the matching setting is on. Needs curl.
name=$(basename "$0")
case "$name" in
  gustaf-device) hint="Turn on Settings > Computer use > Devices > Agent device access in Gustaf and start a new message." ;;
  gustaf-agent) hint="Turn on Settings > Usage > Agents > Subagents from CLI agents in Gustaf and start a new message." ;;
  *) echo "$name: unknown command (expected gustaf-device or gustaf-agent)." >&2; exit 2 ;;
esac
url="${GUSTAF_BRIDGE_URL:-}"
token="${GUSTAF_BRIDGE_TOKEN:-}"
if [ -z "$url" ] || [ -z "$token" ]; then
  echo "$name: not available here. $hint" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "$name: curl is required." >&2
  exit 2
fi
# Text input for the app: stdin when an argument is "-", or the plan file named after `gustaf-agent delegate`.
input=""
for a in "$@"; do
  if [ "$a" = "-" ]; then input="@-"; fi
done
if [ "$name" = "gustaf-agent" ] && [ "${1:-}" = "delegate" ] && [ -n "${2:-}" ] && [ "$2" != "-" ] && [ -f "$2" ]; then
  input="@$2"
fi
# Every argument becomes one form field "a=<value>" (order kept, any characters allowed).
n=$#
while [ "$n" -gt 0 ]; do
  set -- "$@" --data-urlencode "a=$1"
  shift
  n=$((n - 1))
done
if [ -n "$input" ]; then set -- "$@" --data-urlencode "i$input"; fi
out=$(curl -sS --max-time 700 -X POST -H "Authorization: Bearer $token" -w '\n%{http_code}' "$@" "$url/${name#gustaf-}") || {
  echo "$name: cannot reach Gustaf. Is the app running? (A sandbox without network access, such as Codex's workspace-write sandbox, blocks this command.)" >&2
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
