#!/usr/bin/env bash
# PreToolUse hook for Edit / Write.
# When the target path matches a trigger glob, inject a reminder to read
# the matching knowledge/ body file(s) before editing. Silent on no match.
#
# Trigger table is intentionally short — extend it when a new correctness-
# critical surface emerges in this workspace. Keep matches specific to
# avoid false positives.
#
# This template ships with an empty trigger table. Add `case` arms below
# for any path / file pattern whose edits should be gated by reading a
# specific knowledge/ entry first. Examples (commented):
#
#   */legal/*.md|*/privacy/*.md)
#     match="knowledge/topics/security/legal-privacy.md (legal pages are load-bearing — do NOT publish retention durations without checking)" ;;
#   *Caddyfile|*caddy*.conf|*access.log*)
#     match="knowledge/topics/security/legal-privacy.md (access log rules)" ;;
#   *docker-compose*.yml|*ports.md|*ports.ts)
#     match="knowledge/topics/ops/dev-ports.md (port allocation rules)" ;;
#   *auth*|*token*|*session*.ts|*session*.py)
#     match="knowledge/topics/security/auth.md (token storage rules)" ;;
#   */conception/configuration.json|*/conception/configuration.yml)
#     match="the file's own header + .claude/skills/projects/worktree.md (configuration schema)" ;;

set -euo pipefail

payload=$(cat)
path=$(jq -r '.tool_input.file_path // empty' <<<"$payload" 2>/dev/null || true)
[[ -z "$path" ]] && exit 0

match=""
case "$path" in
  # Add per-workspace triggers here. See header for examples.
  *) ;;
esac

[[ -z "$match" ]] && exit 0

jq -n \
  --arg path "$path" \
  --arg knowledge "$match" \
  '{
     hookSpecificOutput: {
       hookEventName: "PreToolUse",
       additionalContext: ("Before editing `" + $path + "`, read `" + $knowledge + "` — these files encode durable rules that apply to this path.")
     }
   }'
