#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
STATE="$(state_dir)"
PARENT_ID="$(echo "$INPUT" | jq -r '.parent_conversation_id // .conversation_id // empty' 2>/dev/null || true)"
if [[ -n "$PARENT_ID" && "$PARENT_ID" != "$CONV_ID" ]]; then
  PARENT_STATE="$ROOT/state/$PARENT_ID"
  if [[ -f "$PARENT_STATE/allowed_files.md" ]]; then
    mkdir -p "$STATE"
    cp -f "$PARENT_STATE/allowed_files.md" "$STATE/allowed_files.md"
    printf 'agent\n' >"$STATE/mode"
    date +%s >"$STATE/session_ts"
  fi
fi
emit_quiet
