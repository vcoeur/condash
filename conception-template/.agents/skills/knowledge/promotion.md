# /knowledge — promotion (the three-yes gate, the check, deferred re-evaluation)

The canonical promotion contract. `projects` and `knowledge` both point here; do not restate it elsewhere.

Durable findings from project work enter `knowledge/` only through this gate — it keeps single-PR detail and app-internal trivia out of the tree.

## Three-yes durability test

Before promoting any finding, run it through all three conditions — promote only on three yeses:

1. **Holds beyond this task** — still true even if the task were done differently; not tied to one PR's implementation detail.
2. **Applies to more than one app, or governs the ecosystem** — single-app internals belong in that app's own `AGENTS.md`, not here.
3. **True regardless of the PR's outcome** — a finding made true only *by* the not-yet-merged PR fails this condition at evaluation time (see deferred re-evaluation below).

Three yeses → `/knowledge update`, stamping the origin paragraph `**Transferred:** YYYY-MM-DD → <path>` (the historical promotion marker; the body file also carries the `**Verified:**` freshness stamp from `SKILL.md` § Core rules).

## Promotion check (signalled by `projects`)

`condash projects check-knowledge <slug>` and `condash audit --include check-knowledge` only **signal** that a done project may still hold un-promoted findings — they are read-only and never write the marker. Resolving the signal is the `/knowledge` skill's job: run `condash projects scan-promotions <slug>`, walk each candidate through the three-yes test, and **create the actual knowledge** with `/knowledge update` (stamping the origin paragraph as above). Only once the real promotion is done — or every candidate is genuinely dropped — does the project record `- YYYY-MM-DD — Checked knowledge promotion` as its last timeline entry. The marker attests that this work happened; never append it as a substitute for doing it.

## Deferred re-evaluation

A finding that passes conditions 1 and 2 but fails only condition 3 — because its truth is *established by* a not-yet-merged PR — would otherwise be silently stranded in project notes. Instead:

1. Write an open `[knowledge-recheck:pending]` timeline marker in the project README.
2. After the PR merges, re-run the three-yes test; on a pass, promote via `/knowledge update` and update the marker to `[knowledge-recheck:done]`.
3. `condash audit --include check-knowledge-deferred` surfaces any unmatched open marker across all projects (closed ones included), so the deferral can't be buried.
