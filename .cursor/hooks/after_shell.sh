#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
STATE="$(state_dir)"
mkdir -p "$STATE"
CMD="$(echo "$INPUT" | jq -r '.command // empty' 2>/dev/null || true)"
EXIT_CODE="$(echo "$INPUT" | jq -r '.exit_code // .exitCode // "?"' 2>/dev/null || echo "?")"
printf '%s | SHELL | exit=%s | %s\n' \
  "$(date +%Y-%m-%d\ %H:%M:%S)" "$EXIT_CODE" "${CMD:0:200}" >>"$STATE/session.log" 2>/dev/null || true
emit_quiet
