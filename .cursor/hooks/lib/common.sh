#!/usr/bin/env bash

resolve_root() {
  local d
  for d in "$HERE/.." "$HERE/../.." "$HERE/../../.."; do
    if [[ -f "$d/HANDOFF.md" || -f "$d/AGENTS.md" ]]; then
      ROOT="$(cd "$d" && pwd)"; return 0
    fi
  done
  ROOT="$(cd "$HERE/.." && pwd)"
}

state_dir() {
  if [[ -n "${CONV_ID:-}" && "${CONV_ID:-}" != "default" ]]; then
    printf '%s/state/%s\n' "$ROOT" "$CONV_ID"
  else
    printf '%s/state\n' "$ROOT"
  fi
}

extract_conv_id() {
  local id
  id="$(printf '%s' "$1" | jq -r '.conversation_id // .session_id // empty' 2>/dev/null || true)"
  [[ -z "$id" || "$id" == "null" ]] && id="default"
  printf '%s' "$id"
}

emit_allow() { echo '{"action":"allow"}'; }

emit_deny() {
  local msg="$1"
  jq -n --arg m "$msg" '{action:"deny", user_message:$m}'
}

emit_followup() {
  local msg="$1"
  jq -n --arg m "$msg" '{followup_message: $m}'
}

emit_quiet() { echo '{}'; }

emit_context() {
  local ctx="$1"
  jq -n --arg c "$ctx" '{additionalContext: $c}'
}

is_agent_mode() {
  local mode=""
  [[ -n "${STATE:-}" && -f "$STATE/mode" ]] && mode="$(cat "$STATE/mode" 2>/dev/null || echo "")"
  [[ -z "$mode" || "$mode" == "agent" ]]
}

_LOCK_FD=""
acquire_lock() {
  local lockfile="$(state_dir)/gate.lock"
  mkdir -p "$(state_dir)"
  exec 200>"$lockfile"
  _LOCK_FD=200
  flock -n 200 || { emit_deny "State busy (parallel hook collision), retry."; exit 0; }
}

release_lock() {
  [[ -n "$_LOCK_FD" ]] && flock -u "$_LOCK_FD" 2>/dev/null || true
}
