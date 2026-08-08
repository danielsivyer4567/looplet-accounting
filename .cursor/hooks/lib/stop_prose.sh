#!/usr/bin/env bash
# Sourced by stop_rules.sh. Pure prose-pattern predicates.
# Each predicate echoes 1 (match) or 0 (no match) so callers can branch once.

pe_has_intent()    { echo "$PROSE" | grep -iqE '^[[:space:]]*INTENT:'    && echo 1 || echo 0; }
pe_has_done_when() { echo "$PROSE" | grep -iqE '^[[:space:]]*Done-when:' && echo 1 || echo 0; }
pe_stop_accepted() { echo "$PROSE" | grep -Fq 'STOP ACCEPTED'            && echo 1 || echo 0; }

pe_dw_met() {
  echo "$PROSE" | grep -iqE 'Done-when[[:space:]]*:[[:space:]]*(met|cumplido|complete|done)\b|✅[[:space:]]*Done-when[[:space:]]+met' \
    && echo 1 || echo 0
}

pe_dw_pred_count() {
  echo "$PROSE" | awk 'tolower($0)~/^[[:space:]]*done-when:/{dw=1;next} dw&&/^[[:space:]]*[-•*][[:space:]]/{n++;next} dw&&/^[[:space:]]*[0-9]+[.)][[:space:]]/{n++;next} dw&&tolower($0)~/^(intent|objective|constraints|files|scope|risk):/{dw=0} END{print n+0}'
}

pe_intent_body_lines() {
  echo "$PROSE" | awk 'tolower($0)~/^[[:space:]]*intent:/{p=1;n=0;next} p&&tolower($0)~/^[[:space:]]*done-when:/{exit} p&&NF{n++} END{print n+0}'
}

pe_anchor_count() {
  echo "$PROSE" | grep -ciE '^[[:space:]]*(INTENT|OBJECTIVE|CONSTRAINTS|FILES|SCOPE|RISK):' || true
}

pe_permission_ask() {
  local ask_re='(déjame saber|quieres que|puedo (hacer|agregar)|me avisas|debería agregar|let me know if|want me to|should I (add|also)|I can (add|also)|if you('\''|’)d like|if you want( me)? to|say if you want)'
  echo "$PROSE" | grep -iqE "$ask_re" && echo 1 || echo 0
}

pe_drip() {
  echo "$PROSE" | grep -iqE '(next (pass|step|turn|iteration|phase)|will continue|partial(ly)?|remaining files|in a follow-?up|siguiente (pass|turno|paso|fase)|dejar[eé] para|pr[oó]xim[oa]|luego|m[aá]s tarde|subsequent|later|resto|handle the rest|proceed with the rest)' \
    && echo 1 || echo 0
}
