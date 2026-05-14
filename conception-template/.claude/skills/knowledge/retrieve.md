# /knowledge — retrieve (triage walk + search)

Read-only lookup over the `knowledge/` tree. Two flavours:

- **Triage walk** — the normal "does `knowledge/` say anything about X?" flow. Walk indexes top-down.
- **Grep** — fallback when the triage walk doesn't land.

## Triage walk (default)

Trigger: `/knowledge retrieve <query>`, or any "check knowledge for …" ask.

```bash
condash knowledge retrieve "<query>" --mode both --json
```

The CLI walks `knowledge/index.md` and the matching subdir indexes, scoring each entry's keyword tags + description against the query, and falls through to a body-file grep when triage returns zero matches. Returns:

- `data.triageMatches[]` — `{path, title, description, keywords, matchedKeywords, verifiedAt, verifiedStale}` per matching index entry. `verifiedStale` is `true` when the body file's `**Verified:**` stamp is older than 30 days — surface that to the user when quoting.
- `data.grepMatches[]` — `{path, line, snippet, section}` per body-file hit (only populated when triage came back empty).

Then **open the body file** of the strongest match and **quote** the relevant passage back to the user with a `file:line` reference.

Rules:

- Use the `matchedKeywords` array as the triage signal (canonical search vocabulary). Descriptions disambiguate when several entries share a tag.
- Most lookups should resolve in the triage layer; only open a body file when one entry clearly matches.
- If a `verifiedStale: true` entry is the only relevant hit, quote it but flag the staleness and suggest `/knowledge verify`.

Non-exhaustive triggers — always consult `knowledge/` before editing or advising:

- Touching an **app**? → read `internal/index.md`, open the matching `internal/<app>.md` for conception-side knowledge, then jump to that app's own `CLAUDE.md` for in-repo details.
- Changing how we call a **third-party service**? → read `external/<system>.md`.
- Touching any **cross-cutting concern** (ports, legal/privacy, auth, deployment, logging…)? → read the matching `topics/<subcategory>/<topic>.md`.
- Workspace-specific high-stakes triggers — log analytics, legal pages, payment flows, etc. — should be captured in `knowledge/conventions.md` or surfaced through the `PreToolUse` hook (`.claude/hooks/knowledge-retrieve-reminder.sh`). The hook is a backstop; reading `knowledge/` proactively when the topic is obvious from the prompt is still on you.

## Grep fallback

Trigger: `/knowledge retrieve grep <pattern>` or when the triage walk comes back empty.

```bash
condash knowledge retrieve "<pattern>" --mode grep --json
```

Skips the index walk and goes straight to a body-file grep (excluding `index.md` files — those are pointers, not sources). Report `<subdir>/<file>:<line>: <snippet>` per match. Open the strongest match and quote the relevant passage back to the user.

## Rules

- **Don't repeat what's in the body file** — quote verbatim with a source reference, so the user can verify.
- **Respect stamps.** If a fact is stamped `**Verified:** YYYY-MM-DD <where>` and the date is older than a month, note the staleness when quoting — and suggest `/knowledge verify` if several stale stamps are relevant.
- **Cross-link.** If the body file references an item under `projects/`, mention it; the user may want to read the item too.
