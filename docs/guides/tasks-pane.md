---
title: The Tasks pane · condash guide
description: Save reusable, parameterized agent prompts as tasks, fill their markers in a form, and run them — condash spawns the agent and submits the filled prompt.
---

# The Tasks pane

> **Audience.** You re-type the same agent prompt with small variations — "review *this* app's docs", "triage *that* incident" — and want it saved once and run in two clicks.

A **task** is a reusable, parameterized agent prompt: a name, a referenced [agent](agent-clis-and-models.md), and a markdown prompt that carries fillable `{markers}`. You fill the markers in a form, click **Run**, and condash spawns the agent in a fresh terminal tab and submits the filled prompt.

The Tasks pane is a **left-band view** with its own edge-strip handle, ordered **Projects · Tasks · Deliverables**. Click the **Tasks** handle to fill the left band with it (clicking the active handle hides the band). Which view was last shown is remembered across launches (the `leftView` layout field).

## Where tasks live

Each task is one directory under your conception:

```
<conception>/tasks/
  refresh-app-docs/
    task.json      { "name": "Refresh app docs", "agent": "claude-deepseek-v4-pro", "submit": true }
    prompt.md      Review {APP} and update its docs. Focus: {AREA:CLAUDE.md and docs/}
```

- **`task.json`** carries config only — `name`, `agent` (the **id** of an agent from the `agents` settings list), and `submit` (optional, default `true`).
- **`prompt.md`** is the raw markdown prompt with markers — a real, hand-editable, diffable file. Edit it in the pane or in your editor; both round-trip.
- The directory name is the **slug** (`^[a-z0-9-]+$`). The `tasks/` tree is created on first save.

Config in JSON, prose in markdown — the same split the rest of the conception follows.

## The marker grammar

Markers are parsed from `prompt.md`:

| Marker | Meaning |
|--------|---------|
| `{KEY}` | required field, empty default |
| `{KEY:default value}` | field prefilled with `default value` (runs to the next `}`; spaces allowed) |

`KEY` is `[A-Za-z_][A-Za-z0-9_]*` — convention is `UPPER_SNAKE`. A key used several times shows **one** field and substitutes everywhere.

### Reserved pickers: `{APP}` and `{PROJECT}`

Two key families render as **searchable pickers** instead of text fields, and one selection populates the whole family:

| Marker | Field | Bare value | Sub-tokens |
|--------|-------|-----------|------------|
| `{APP}` | app picker | `#<repo>` (e.g. `#condash`) | `{APP_NAME}` (repo name), `{APP_PATH}` (absolute checkout path) |
| `{PROJECT}` | project picker | the slug | `{PROJECT_SLUG}`, `{PROJECT_PATH}` (rel path), `{PROJECT_BRANCH}`, `{PROJECT_BASE}`, `{PROJECT_TITLE}` |

A prompt that uses only a sub-token (say just `{APP_PATH}`) still surfaces the matching picker — picking an app fills every `APP_*` token at once.

The app picker lists your configured [repositories](repositories-and-open-with.md); the project picker lists the projects condash already loaded.

### Provided variables: `{TABS}` and `{UPDATED_TABS}`

`{TABS}` and `{UPDATED_TABS}` are **condash-provided** markers — never fillable fields; condash injects them from runtime state. `{TABS}` expands to the JSON list of the open terminal tabs that exist right now:

```json
[ { "sid": "t-a1b2c3d4", "cwd": "/home/you/src/...", "repo": "condash", "cmd": "agedum claude" } ]
```

Only the tabs that actually exist are injected — no prior titles, no closed tabs. A task that wants to reason about "what is running where" reads `{TABS}` and looks each session up via [`condash logs read`](../reference/cli.md).

`{UPDATED_TABS}` is the **same shape, narrowed to the tabs that produced new output since this task's last scheduled run** — condash drops the ones with nothing new. A recurring task should prefer it: it does the "what changed?" filtering in condash (cheap, no model call) so the agent only acts on the tabs worth re-reading, and when *nothing* changed the scheduler skips the run entirely (see *Schedule a task*). On a manual run there is no "last run" to diff against, so `{UPDATED_TABS}` is seeded to the full open set. The shipped **Term titles** task (below) is built on it.

## Run a task

A task card carries a single **Run…** button — clicking it opens the **run popup**:

1. Open the **Tasks** handle and click **Run…** on a task card.
2. At the top, the **Agent** select defaults to the task's stored agent — leave it, or switch it to run this one time with a different agent (only prompt-seedable agents are selectable). The **Run** button sits beside it.
3. Fill the markers below — pick an app / project where prompted, edit the text fields (prefilled from defaults).
4. A **Run mode** select and a **Keep out of logs** checkbox sit beside the agent picker, each prefilled from the task's default (below). Run mode switches this one run between **Interactive (`--prompt`)** and **One-shot (`--run`)** (disabled for an opaque agent). When *Keep out of logs* is ticked, this run's console log is routed to `.condash/manual/<slug>/` instead of the normal session logs — the tab is still visible.
5. The **Prompt to run** box previews the substituted text live.
6. Click **Run**. condash spawns the chosen agent in a fresh terminal tab (working directory = the conception root), names the tab **`<agent>•<task name>`** so a running task is identifiable at a glance, and delivers the filled prompt: typed into the tab (then Enter when **submit** is on) for an opaque agent, or passed in argv for a **promptFlags** agent — `--prompt` (interactive) or `--run` (one-shot) per the chosen run mode.

Run is disabled when the selected agent is not defined — pick a current one from the top select (a task whose stored agent went missing opens with that dangling id shown as *(missing)*). The card's **Run…** button itself stays disabled while the task's stored agent is missing (the card shows a *missing* badge).

## Create or edit a task

Click **+ New task**, or **click a task card** to open the **editor popup** for an existing task:

- **Name** — the card title. For a new task the **slug** auto-derives from the name until you hand-edit it.
- **Agent** — pick an agent from the [`agents` settings list](agent-clis-and-models.md#register-it-as-a-condash-agent); the select shows the agent's `label` and stores its stable `id`. Only agents with [`promptFlags`](../reference/config.md#agents) are selectable — a task hands its filled prompt to the agent via `--prompt`/`--run`, which an opaque command can't accept. Agents without the flag are shown disabled (a new task defaults to the first prompt-seedable agent). A task already pointing at an opaque agent keeps that selection and still runs via the type-into-tab fallback.
- **Submit** — press Enter after typing (on by default).
- **Prompt** — markdown with `{MARKERS}`. The **Markers** chips below update live as you type so you can see the fields you're creating.
- **Schedule** — an opt-in cadence picked from a fixed list (*Off*, 1m, 5m, 30m, 1h, 2h, 6h, 12h, 1d, 7d). See *Schedule a task* below.
- **Run mode** — how a prompt-seedable agent is driven, and the default for this task's runs (overridable per run): **Interactive (`--prompt`)** keeps the tab open after the prompt runs; **One-shot (`--run`)** runs the prompt once and exits. Prefer one-shot for a scheduled task so its headless run exits cleanly instead of waiting for the timeout. Moot for an opaque agent (the keystroke path is interactive only).
- **Run timeout** — shown only once a schedule is set: how long a single headless run may live before it is killed and discarded (1m / 5m / 10m / 30m / 1h; default 10m). See *Schedule a task*.
- **Keep manual runs out of the normal logs** — the per-task default for the run-popup toggle.

The editor carries **Save** / **Cancel** and, for an existing task, a **Delete** button that asks for confirmation first. Renaming the slug moves the task directory.

The **Schedule**, **Run mode**, **Run timeout**, and **Keep out of logs** fields are *not* stored in `task.json` (which stays `name` + `agent`); they live under a `taskConfig` map keyed by slug in `.condash/settings.json` (a conception may override it in `condash.json`). Clearing them all removes the entry.

## Schedule a task

A task with a **Schedule** cadence runs itself on that interval — **headless**, with no visible tab and no `termSessions` broadcast. There is no default schedule and no default agent: a task is inert until you give it a cadence, and it always carries its own (prompt-seedable) agent.

A scheduled run is **never** written to the normal session logs. Its console output is teed to `.condash/scheduled/<slug>/` (last ~5 runs kept), independent of your global terminal-logging toggle — purely for debugging the agent's chatter. The run's actual *product* is whatever the task itself writes (e.g. `.condash/term-titles.json`); condash does not capture it.

The scheduler is cheap on idle workspaces: it **single-flights** (never overlaps a still-running run of the same task) and **per-tab growth-gates** — it skips a tick when no open tab produced new output since the last run, and when some did, it hands the run just those changed tabs via [`{UPDATED_TABS}`](#provided-variables-tabs-and-updated_tabs). So a quiet workspace spends nothing, and a busy one only pays for the tabs that actually moved.

**Run mode + run timeout.** Set the task's **Run mode** to **One-shot (`--run`)** so a scheduled run exits cleanly the moment the agent finishes — then the **Run timeout** (default 10m) is just a safety cap on a hung run. With the default **Interactive (`--prompt`)** the agent finishes its work but does *not* exit the process, so the timeout doubles as the *discard* mechanism: without it the run would hold the single-flight slot, stretching the *effective* cadence out to the timeout regardless of the schedule. If you keep a scheduled task interactive, keep the timeout **≤ the schedule interval** so each cycle frees the slot before the next is due.

### Running runs

While a scheduled run is in flight it appears in a **Running** section at the bottom of the Tasks pane. Each row shows the task and how long the run has been alive; expand it to tail the run's live log, or hit **Kill** to terminate and discard it immediately.

## Keep runs out of the logs

The **Keep out of logs** toggle (per-task default in the editor, overridable per run in the popup) routes a *manual* run's `.txt` to `.condash/manual/<slug>/` instead of `.condash/logs/`. The tab stays visible and interactive; only its on-disk log location changes. With the flag off, the run logs normally.

Both stores — `.condash/scheduled/<slug>/` and `.condash/manual/<slug>/` — are browsable from the Logs pane's **Task runs** view, and stay invisible to the normal Logs list, search, and reports.

## The shipped `term-titles` task

A fresh conception ships an adoptable `tasks/term-titles/` task (it is **not** auto-scheduled). It reads `{UPDATED_TABS}` (only the tabs that changed since its last run), skims each one's recent [`condash logs read --tail`](../reference/cli.md), refines a short title + one-sentence summary, and writes the sparse `.condash/term-titles.json` that condash watches to auto-name the tabs (see [the embedded terminal](terminal.md#auto-titled-tabs)). Because the per-tab growth gate already drops the idle tabs, the task only spends model tokens on tabs that actually moved. Give it a cheap, prompt-seedable agent and a `Schedule` of a minute or two to keep your tab titles current.

## See also

- **[Agent CLIs and model providers](agent-clis-and-models.md)** — define the agents a task references.
- **[The deliverables pane](deliverables-pane.md)** — the other left-band view that shares the edge strip.
- **[The embedded terminal](terminal.md)** — where a running task's agent tab opens.
