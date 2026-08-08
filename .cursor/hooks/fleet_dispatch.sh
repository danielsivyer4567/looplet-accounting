#!/usr/bin/env bash
set -uo pipefail

show_help() {
  printf '%s\n' \
    "fleet_dispatch.sh — Selective-Autonomy backlog dispatcher" \
    "" \
    "Reads a prioritized backlog (state/backlog.md), picks the top task, and" \
    "dispatches it to the agent (cursor-agent, headless) under the same hook" \
    "guardrails as interactive sessions." \
    "" \
    "Safety model:" \
    "  SAFE tasks (docs / todos / stubs / READMEs): auto-dispatched." \
    "  CODE tasks (src edits, refactors, migrations): proposed only, need --human." \
    "  Runtime hook chain still enforces FILE_MAP scope per task." \
    "" \
    "Backlog format (one task per line, prefix = priority):" \
    "  [P0] fix auth logout bug in src/auth.rs" \
    "  [P1] write README for ponytail skill" \
    "  [P2] add TODO stub for billing module" \
    "Lines starting with # are comments. Blank lines ignored." \
    "" \
    "Usage:" \
    "  fleet_dispatch.sh              dispatch top task (auto if safe, else propose)" \
    "  fleet_dispatch.sh --human      require explicit approval even for safe tasks" \
    "  fleet_dispatch.sh --peek       print top task + classification, do nothing" \
    "  fleet_dispatch.sh --init       create empty backlog.md template"
}

HERE="$(cd "$(dirname "$0")" && pwd)"
PACK="$(cd "$HERE/.." && pwd)"
ROOT=""
for d in "$HERE/.." "$HERE/../.." "$HERE/../../.."; do
  if [[ -f "$d/HANDOFF.md" || -f "$d/AGENTS.md" ]]; then ROOT="$(cd "$d" && pwd)"; break; fi
done
[[ -z "$ROOT" ]] && ROOT="$PACK"
STATE="$ROOT/state"
BACKLOG="$STATE/backlog.md"
mkdir -p "$STATE"
HUMAN=0
PEEK=0
INIT=0
for a in "$@"; do
  case "$a" in
    --human) HUMAN=1 ;;
    --peek) PEEK=1 ;;
    --init) INIT=1 ;;
    -h|--help) show_help; exit 0 ;;
  esac
done

init_backlog() {
  [[ -f "$BACKLOG" ]] && { echo "[skip] backlog already exists: $BACKLOG"; return 0; }
  cat > "$BACKLOG" <<'EOF'
EOF
  echo "[ok] created backlog template: $BACKLOG"
}

top_task() {
  local best="" best_p=99 line p text
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// }" ]] && continue
    [[ "${line:0:1}" == "#" ]] && continue
    if [[ "$line" =~ ^\[P([0-9]+)\][[:space:]]*(.*)$ ]]; then
      p="${BASH_REMATCH[1]##0}"; p="${p:-0}"
      text="${BASH_REMATCH[2]}"
      if (( p < best_p )); then best_p="$p"; best="$text"; fi
    fi
  done < "$BACKLOG"
  printf '%s\t%s\n' "$best_p" "$best"
}

classify() {
  local t="$1"
  if echo "$t" | grep -qiE '(write|update|add|create|document|doc|readme|todo|stub|comment|note|frontmatter)'; then
    if ! echo "$t" | grep -qiE '(src/|refactor|migrat|implement|fix|bug|auth|config|\.rs|\.ts|\.tsx|\.py|\.go|\.js|database|schema|api|endpoint|component)'; then
      echo "SAFE"; return
    fi
  fi
  echo "CODE"
}

[[ "$INIT" -eq 1 ]] && { init_backlog; exit 0; }
[[ -f "$BACKLOG" ]] || init_backlog

read -r PRI TASK < <(top_task)
if [[ -z "$TASK" ]]; then
  echo "[idle] backlog empty — nothing to dispatch."
  exit 0
fi

CLASS="$(classify "$TASK")"
echo "=== fleet_dispatch ==="
echo "  priority: P$PRI"
echo "  task:     $TASK"
echo "  class:    $CLASS"

if [[ "$PEEK" -eq 1 ]]; then
  echo "  [peek] no action taken."
  exit 0
fi

FILEMAP="$(echo "$TASK" | grep -oE '(edit|NEW):[A-Za-z0-9_./+=-]+' | sed 's/^[^:]*://' | grep -vx 'path'; echo "$TASK" | grep -oE '(src|tests|docs)/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+')"
if [[ -n "$FILEMAP" ]]; then
  printf '%s\n' "$FILEMAP" > "$STATE/allowed_files.md"
  echo "  filemap:  $(echo "$FILEMAP" | tr '\n' ' ')"
else
  : > "$STATE/allowed_files.md"
fi
printf 'agent\n' > "$STATE/mode"
date +%s > "$STATE/session_ts"
mkdir -p "$STATE"

if [[ "$CLASS" == "CODE" ]]; then
  echo "  [PROPOSE] CODE task — requires human approval (pre_tool_use guards apply at runtime)."
  if [[ "$HUMAN" -eq 0 ]]; then
    echo "  Run:  fleet_dispatch.sh --human   (or dispatch manually with this scope)"
    exit 0
  fi
  echo "  [HUMAN=1] dispatching CODE task under hook guardrails..."
fi

if [[ "$HUMAN" -eq 1 && "$CLASS" == "SAFE" ]]; then
  echo "  [HUMAN=1] dispatching SAFE task with explicit approval..."
fi

PROMPT="INTENT: $TASK
Tag every file as edit:path or NEW:path. Done-when: ≤5 decidable predicates. Finish all tagged files this turn; proof via build/test where applicable."
CURSOR_CLI="${CURSOR_CLI:-}"
if [[ -z "$CURSOR_CLI" ]]; then
  command -v cursor-agent >/dev/null 2>&1 && CURSOR_CLI="cursor-agent"
fi
if [[ -z "$CURSOR_CLI" ]]; then
  command -v cursor >/dev/null 2>&1 && CURSOR_CLI="cursor"
fi
if [[ -z "$CURSOR_CLI" ]]; then
  echo "  [fail] no Cursor CLI on PATH (cursor-agent/cursor) — install Cursor or set CURSOR_CLI."
  exit 1
fi
echo "  [dispatch] $CURSOR_CLI <task>"
out="$("$CURSOR_CLI" "$PROMPT" 2>&1)"
rc=$?
printf '%s\n' "$out" | tail -20
echo "  [done] dispatch returned (exit $rc)."

tmp="$(mktemp)"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == "[P${PRI}] $TASK" || "$line" == "[P0$PRI] $TASK" ]]; then
    echo "# DONE $(date +%F): $line" >> "$tmp"
  else
    echo "$line" >> "$tmp"
  fi
done < "$BACKLOG"
if [[ "$rc" -eq 0 ]]; then
  mv "$tmp" "$BACKLOG"
else
  rm -f "$tmp"
  echo "  [keep] backlog kept — dispatch failed."
fi
exit 0
