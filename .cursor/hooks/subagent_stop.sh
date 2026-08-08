#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
STATE="$(state_dir)"
mkdir -p "$STATE"
STATUS="$(echo "$INPUT" | jq -r '.status // "completed"' 2>/dev/null || echo "completed")"
echo "$INPUT" | jq -r '.modified_files[]?' 2>/dev/null | while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  grep -qxF "$f" "$STATE/allowed_files.md" 2>/dev/null || echo "$f" >>"$STATE/allowed_files.md"
done
if [[ "$STATUS" != "completed" ]]; then
  emit_quiet; exit 0
fi
emit_quiet
