#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
STATE="$(state_dir)"
mkdir -p "$STATE"
date +%s >"$STATE/session_ts"
MODE="$(echo "$INPUT" | jq -r '.composer_mode // empty' 2>/dev/null || true)"
[[ -z "$MODE" ]] && MODE="agent"
printf '%s\n' "$MODE" >"$STATE/mode"
if [[ "$MODE" != "agent" ]]; then
  emit_quiet; exit 0
fi
PROMPT="$(echo "$INPUT" | jq -r '.prompt // .user_prompt // .message // .text // empty' 2>/dev/null || true)"
ROUTE="other"
echo "$PROMPT" | grep -qiE 'implement|fix|refactor|bug|code|patch|cargo|typescript|rust|bash|connect|conecta|wire|api|frontend|backend|component|hook|render|data|fetch|endpoint|función|pantalla|página|landing|database|query|mutation|state|effect|deploy|despliega|build|construye|configura|integra|test|ssh|server|servidor|inventory|inventario|docker|nginx|systemd|service|servicio|infra|host|vm|container|rollback|migrate|pipeline|ci\b|cd\b' && ROUTE="code"
printf '%s\n' "$PROMPT" >"$STATE/current_intent.md"
echo "$PROMPT" | grep -oE '(edit|NEW):[A-Za-z0-9_./+=-]+' | sed 's/^[^:]*://' \
  | grep -vx 'path' >"$STATE/allowed_files.md" 2>/dev/null || true
PROMPT_NORM="$(printf '%s' "$PROMPT" | iconv -f UTF-8 -t ASCII//TRANSLIT//IGNORE 2>/dev/null || printf '%s' "$PROMPT")"
OUTCOMES=$(printf '%s' "$PROMPT_NORM" | grep -oiE '\b(conecta|implementa|arregla|crea|asegurate?|verifica|anhade|remueve|actualiza|refactoriza|configura|despliega|integra|construye|optimiza|corrije|migra|documenta|escribe|disena|connect|implement|fix|create|ensure|verify|add|remove|update|refactor|configure|deploy|integrate|build|optimize|migrate|document|write|design|test)\b' | wc -l || true)
OUTCOMES="${OUTCOMES//[!0-9]}"
[[ -z "$OUTCOMES" || "$OUTCOMES" -lt 1 ]] && OUTCOMES=1
[[ "$OUTCOMES" -gt 5 ]] && OUTCOMES=5
printf '%s\n' "$OUTCOMES" >"$STATE/outcomes.md"
DUTY="$(jq -r '.duty // empty' "$HERE/policy/intent.json" 2>/dev/null || true)"
[[ -z "$DUTY" ]] && DUTY="INTENT chat prose before tools; tag edit:|NEW:; never Shell-declare."
PENDING=""
if [[ -s "$STATE/pending_files.md" ]]; then
  PENDING="PENDING_FILES (finish this turn, no drip): $(tr '\n' ' ' <"$STATE/pending_files.md")"
fi
OUTCOMES_CTX=""
[[ -s "$STATE/outcomes.md" ]] && OUTCOMES_CTX="OUTCOMES_DETECTED: $(cat "$STATE/outcomes.md") user outcome(s) → Done-when MUST list ≥ that many predicates (1 per outcome). Under-scoped Done-when is rejected."
CONSTRAINT_REM=""
if [[ "$ROUTE" == "code" ]]; then
  EPILOGUE="Codebase first: Read AGENTS.md/CLAUDE.md + manifest, Glob/Grep the feature area, THEN edit. Update HANDOFF at session END — NOT before tools."
  if ! echo "$PROMPT" | grep -qiE '(líneas|loc|archivos|módulos|modules|files|max|límit|roof|menos de|under)'; then
    CONSTRAINT_REM="CONSTRAINTS: no explicit bounds given — ponytail defaults apply (700 LOC roof, 15 edits/file, one responsibility per file). State your own if tighter."
  fi
else
  EPILOGUE="Task-first. Update HANDOFF at session end if durable."
fi
emit_context "ROUTE_CLASSIFY: ${ROUTE}
DEBERES: ${DUTY}
FILE_MAP: ground Glob|Grep|Read → tag edit:path|NEW:path in chat INTENT → StrReplace existing; Write only NEW → re-Read tags → prove Done-when. Never echo INTENT into Shell.
SANDBOX: paths detected in your prompt are snapshotted to state/allowed_files.md. Writes outside this set warn at edit time and register in the sandbox; stop_gate audits that every tagged file is finished. Declare every edit:|NEW: path in your INTENT.
${OUTCOMES_CTX}
${PENDING}
${CONSTRAINT_REM}
${EPILOGUE}"
