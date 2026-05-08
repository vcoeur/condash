<!-- condash:general:begin -->
# CLAUDE.md — conception

A **systems documentation tree**, not a code project. Everything here is Markdown — there is nothing to run.

## Pointers

- `/projects` — items + worktrees. Canonical rules: [`projects/SKILL.md`](.claude/skills/projects/SKILL.md).
- `/knowledge` — durable reference material. Canonical rules: [`knowledge/SKILL.md`](.claude/skills/knowledge/SKILL.md).
- `/pr` — project-aware GitHub PR opener. Canonical rules: [`pr/SKILL.md`](.claude/skills/pr/SKILL.md).
- `/skills` — pull condash-shipped skill updates. Canonical rules: [`skills/SKILL.md`](.claude/skills/skills/SKILL.md).
- Tree roots: [`projects/index.md`](projects/index.md), [`knowledge/index.md`](knowledge/index.md).
- [`configuration.json`](configuration.json) — workspace + preferences config read by condash.

## Workflow

- **Autonomy**: when the next action is obvious from context, proceed — don't ask. Ask when the call is genuinely ambiguous or the action is hard to reverse. Terse prompts like "redo now", "close it", "ship" are explicit permission to run end-to-end without per-step confirmation.
- **Auto-memory opt-out**: this tree does not use the harness auto-memory. Durable team rules go in the **Specific** section below; durable reference material lives under [`knowledge/`](knowledge/index.md). Never write to `~/.claude/projects/<encoded-path>/memory/` for this tree.
- **"Doesn't work" reports**: ask one clarifying question about the actual symptom before editing — especially before touching shared infrastructure (skill files, settings, hook scripts). Search the **Specific** section below and `knowledge/` for keywords from the report first.
<!-- condash:general:end -->

## Specific to this conception

The general section above is shipped by condash and applies to every conception tree. Add rules below that are specific to this conception — durable team rules surfaced in session, workspace facts, and any pre-skill defaults that don't hold for every conception. Each rule should carry a one-line **Why** (rationale) and **How to apply** (when it kicks in). Stable by design — no verification stamps.
