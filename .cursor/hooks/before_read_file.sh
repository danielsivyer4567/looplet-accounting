#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib/common.sh"
resolve_root
INPUT="$(cat)"
CONV_ID="$(extract_conv_id "$INPUT")"
FILE_PATH="$(echo "$INPUT" | jq -r '.file_path // empty' 2>/dev/null || true)"
case "$FILE_PATH" in
  */.env|*/.env.*|*/.aws/credentials|*/.ssh/id_*|*/.npmrc|*/.pypirc|*/.git-credentials|*/credentials.json|*/secrets.json)
    msg="AUTONOMY BLOCK: reading sensitive file '$FILE_PATH' blocked to protect secrets from model context. Read it yourself if needed."
    if echo "$INPUT" | jq -e '.hook_event_name // empty' >/dev/null 2>&1; then
      jq -n --arg m "$msg" '{permission:"deny", user_message:$m}'
    else
      jq -n --arg m "$msg" '{action:"deny", user_message:$m}'
    fi
    exit 0
    ;;
esac
emit_quiet
