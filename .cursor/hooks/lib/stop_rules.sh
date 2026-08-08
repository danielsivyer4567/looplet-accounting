#!/usr/bin/env bash
# Sourced by stop_gate_core.sh. Holds the INTENT/Done-when/FILE_MAP rule chain.
# Assumes: STATE, HANDOFF, MAX_BODY, MAX_ANCH, PROSE, MSG_N, STATUS already set.
source "$HERE/lib/stop_prose.sh"

TAG_RE='(edit|NEW):[A-Za-z0-9_./+=-]+'
rules_tags() { echo "$PROSE" | grep -oE "$TAG_RE" | sed 's/^[^:]*://' | grep -vx 'path' || true; }

rules_follow() {
  mkdir -p "$STATE"
  printf '%s\n' "$PROSE" >"$STATE/pending_intent.md"
  rules_tags >"$STATE/pending_files.md" 2>/dev/null || true
  emit_followup "$1"; exit 0
}

rules_accept() {
  local date; date="$(date +%Y-%m-%d)"
  rm -rf "$STATE"; mkdir -p "$STATE"
  local archived=""
  if [[ -f "$HANDOFF" ]]; then
    archived="$(sed -n '/^## Archived/,$p' "$HANDOFF" 2>/dev/null | tail -n +2 \
      | grep -vxF '(Older context compacted here when active sections exceed ~150 lines.)' || true)"
  fi
  {
    echo "# HANDOFF — Session State"; echo ""; echo "## Active Objective"; echo ""
    echo "Session complete ${date}"; echo ""; echo "## Current State"; echo ""
    echo "Done-when: met. (agent fills details)"; echo ""; echo "## Next Actions"; echo ""
    echo "Update HANDOFF with next session objective."
    echo ""; echo "## Archived"; echo ""
    if [[ -n "$archived" ]]; then echo "$archived"; echo ""; fi
    echo "(Older context compacted here when active sections exceed ~150 lines.)"
  } >"$HANDOFF"
  emit_quiet; exit 0
}

rules_topology() {
  local violations=""
  while IFS= read -r tag; do
    [[ -z "$tag" ]] && continue
    grep -qxF "$tag" "$STATE/allowed_files.md" || violations="$violations $tag"
  done < <(rules_tags)
  if [[ -n "$violations" ]]; then
    rules_follow "TOPOLOGY VIOLATION: Intentaste tocar un archivo fuera de tu FILE_MAP:$violations. Corrige tu INTENT — solo edita/crea paths que declaraste en tu FILE_MAP, o expande tu INTENT explícitamente."
  fi
  return 0
}

rules_untouched() {
  local session_ts; session_ts="$(cat "$STATE/session_ts" 2>/dev/null || echo 0)"
  session_ts="${session_ts//[!0-9]}"; [[ -z "$session_ts" ]] && session_ts=0
  local untouched=""
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    [[ "$p" = /* ]] && fp="$p" || fp="$(pwd)/$p"
    [[ -f "$fp" ]] || { untouched="$untouched $p(missing)"; continue; }
    local m; m="$(stat -c %Y "$fp" 2>/dev/null || echo 0)"
    m="${m//[!0-9]}"; [[ -z "$m" ]] && m=0
    [[ "$session_ts" -eq 0 || "$m" -ge "$session_ts" ]] || untouched="$untouched $p"
  done < <(rules_tags)
  if [[ -n "$untouched" ]]; then
    rules_follow "FILES NOT TOUCHED:$untouched — every tagged edit:|NEW: path must be written to disk this turn. Edit/write each file, then Done-when: met."
  fi
  return 0
}

rules_run() {
  if [[ $(pe_stop_accepted) -eq 1 ]]; then emit_quiet; exit 0; fi
  [[ "$STATUS" == "completed" && "${MSG_N:-0}" -eq 0 && -z "$PROSE" ]] && rules_accept
  if [[ $(pe_has_intent) -eq 0 || $(pe_has_done_when) -eq 0 ]]; then
    rules_follow "INTENT must be chat prose (first, before tools) — never Shell/Write/code-fence. INTENT: <OBJECTIVE=postcondition; tag edit:path|NEW:path>; Done-when: <≤5 decidable predicates>. Finish ALL tagged FILES this turn; Done-when: met; update HANDOFF."
  fi
  if ! rules_tags | grep -q .; then
    rules_follow "FILE_MAP missing in chat INTENT: tag every path as edit:path or NEW:path. Ground Glob/Grep/Read, then complete every tag this turn — no drip across prompts."
  fi
  if [[ -s "$STATE/allowed_files.md" ]]; then rules_topology; fi
  local outcomes; outcomes="$(cat "$STATE/outcomes.md" 2>/dev/null || echo 1)"
  outcomes="${outcomes//[!0-9]}"; [[ -z "$outcomes" || "$outcomes" -lt 1 ]] && outcomes=1
  local dw_pred; dw_pred="$(pe_dw_pred_count)"
  if [[ "${dw_pred:-0}" -lt "$outcomes" ]]; then
    rules_follow "UNDER-SCOPE: ${outcomes} outcome(s) detected in your prompt but Done-when lists only ${dw_pred:-0} predicate(s) — 1 decidable predicate per outcome (see OUTCOMES_DETECTED). Re-Read tagged FILES; list ≥ ${outcomes} predicates under Done-when ('- ' or '1.' each), prove them, then Done-when: met."
  fi
  local ilines; ilines="$(pe_intent_body_lines)"
  local anch; anch="$(pe_anchor_count)"
  if [[ "${ilines:-0}" -gt "$MAX_BODY" || "${anch:-0}" -gt "$MAX_ANCH" ]]; then
    rules_follow "Thin INTENT roof: ≤${MAX_ANCH} anchors; ≤${MAX_BODY} body lines. Keep postcondition + tags + predicates; drop essay."
  fi
  if [[ $(pe_permission_ask) -eq 1 ]]; then
    rules_follow "STOP REJECTED: permission ask. Complete every tagged FILE this turn, then Done-when: met."
  fi
  if [[ $(pe_drip) -eq 1 ]]; then
    rules_follow "DRIP REJECTED: no multi-prompt drip. Connect every edit:|NEW: path now; prove Done-when; then met."
  fi
  rules_untouched
  if [[ $(pe_dw_met) -eq 0 ]]; then
    rules_follow "PREMATURE STOP: Done-when unmet in chat prose. Re-Read tagged FILES; prove every predicate; finish ALL tags this turn; write Done-when: met."
  fi
  local hl; hl="$(wc -l < "$HANDOFF" 2>/dev/null || echo 0)"; hl="${hl//[!0-9]}"; [[ -z "$hl" ]] && hl=0
  if [[ "$hl" -gt 180 ]]; then
    rules_follow "HANDOFF.md is ${hl} lines (>180 roof). Compact: move older Recent Changes into Archived, compress Failed Attempts to one-liners. Keep active sections under 150 lines, then Done-when: met."
  fi
  rules_accept
}
