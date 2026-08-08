#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
STATE="$(state_dir)"
mkdir -p "$STATE"
MODE="$(echo "$INPUT" | jq -r '.composer_mode // empty' 2>/dev/null || true)"
[[ -z "$MODE" ]] && MODE="agent"
printf '%s\n' "$MODE" >"$STATE/mode"
if [[ "$MODE" != "agent" ]]; then
  emit_quiet; exit 0
fi
HANDOFF="$ROOT/HANDOFF.md"
TAIL=""
if [[ -f "$HANDOFF" ]]; then
  TAIL="$(tail -n 40 "$HANDOFF" | sed -n '/<!-- COMPACTION PROTOCOL/,$d;p' | tail -n 15)"
fi
CTX="Session start. INTENT = chat prose before tools (never Shell). Tag edit:|NEW:; finish all tags this turn. For CODE work: ground in codebase first (AGENTS.md, Glob/Grep, manifest) — update HANDOFF at session END. HANDOFF tail:
${TAIL}"
emit_context "$CTX"
