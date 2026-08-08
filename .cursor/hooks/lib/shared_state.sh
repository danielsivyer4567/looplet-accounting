#!/usr/bin/env bash

log_session_event() {
  local event="$1" details="$2"
  local dir="${STATE:-}"
  [[ -z "$dir" ]] && dir="$(state_dir 2>/dev/null || echo /tmp)"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '%s | %s | %s\n' "$(date +%Y-%m-%d\ %H:%M:%S)" "$event" "$details" >>"$dir/session.log" 2>/dev/null || true
}
