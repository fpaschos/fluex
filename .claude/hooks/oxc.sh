#!/usr/bin/env bash
# PostToolUse (Edit|Write): lint-fix and format the edited file, as in
# https://oxc.rs/docs/guide/usage/coding-agents. Errors left after --fix go back to Claude (exit 2).
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  "$CLAUDE_PROJECT_DIR"/*) ;;
  *) exit 0 ;;
esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
pnpm exec oxlint --fix --no-error-on-unmatched-pattern "$file" >/dev/null 2>&1
pnpm exec oxfmt --no-error-on-unmatched-pattern "$file" >/dev/null 2>&1
errors=$(pnpm exec oxlint --max-warnings=0 --format=agent --no-error-on-unmatched-pattern "$file" 2>/dev/null)
if [ -n "$errors" ]; then
  echo "$errors" >&2
  exit 2
fi
