# /knowledge — retrieve (triage walk + search)

Read-only lookup over the `knowledge/` tree. Two flavours:

- **Triage walk** — the normal "does `knowledge/` say anything about X?" flow. Walk indexes top-down.
- **Grep** — fallback when the triage walk doesn't land.

## Triage walk (default)

Trigger: `/knowledge retrieve <query>`, or any "check knowledge for …" ask.

1. **Read `knowledge/index.md`** first. Match the query against the subdir descriptions + keyword tags.
2. **Open the matching subdir's `index.md`** (`internal/`, `external/`, or `topics/`). Match the query against per-file descriptions + tags.
3. **Open the body file** only when an entry clearly matches. Never act on a one-liner alone.
4. **Quote** the relevant passage back to the user with a file:line reference.

Rules:

- Use keyword tags for triage (canonical search vocabulary) and descriptions for disambiguation when several entries share a tag.
- Most lookups should resolve at the index level: read every relevant `index.md` top-to-bottom, match on descriptions + tags, only open a body when a match is confirmed.
- If no index entry matches, fall through to grep.

Non-exhaustive triggers — always consult `knowledge/` before editing or advising:

- Touching an **app**? → read `internal/index.md`, open the matching `internal/<app>.md` for conception-side knowledge, then jump to that app's own `CLAUDE.md` for in-repo details.
- Changing how we call a **third-party service**? → read `external/<system>.md`.
- Touching any **cross-cutting concern** (ports, legal/privacy, auth, deployment, logging…)? → read the matching `topics/<subcategory>/<topic>.md`.
- Workspace-specific high-stakes triggers — log analytics, legal pages, payment flows, etc. — should be captured in `knowledge/conventions.md` or surfaced through the `PreToolUse` hook (`.claude/hooks/knowledge-retrieve-reminder.sh`). The hook is a backstop; reading `knowledge/` proactively when the topic is obvious from the prompt is still on you.

## Grep fallback

Trigger: `/knowledge retrieve grep <pattern>` or when the triage walk comes back empty.

1. **Grep** `knowledge/**/*.md` (excluding `index.md` files — those are pointers, not sources).
2. **Report** `<subdir>/<file>:<line>: <snippet>` per match.
3. **Open** the matching body file and quote the relevant passage.

## Rules

- **Don't repeat what's in the body file** — quote verbatim with a source reference, so the user can verify.
- **Respect stamps.** If a fact is stamped `**Verified:** YYYY-MM-DD <where>` and the date is older than a month, note the staleness when quoting — and suggest `/knowledge verify` if several stale stamps are relevant.
- **Cross-link.** If the body file references an item under `projects/`, mention it; the user may want to read the item too.
