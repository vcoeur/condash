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

## Run a task

A task card carries a single **Run…** button — clicking it opens the **run popup**:

1. Open the **Tasks** handle and click **Run…** on a task card.
2. Fill the markers — pick an app / project where prompted, edit the text fields (prefilled from defaults).
3. The **Prompt to run** box previews the substituted text live.
4. Click **Run**. condash spawns the task's agent in a fresh terminal tab (working directory = the conception root) and delivers the filled prompt: typed into the tab (then Enter when **submit** is on) for an opaque agent, or passed in argv (`--run` when **submit** is on, else `--prompt`) when the agent has **promptFlags** set.

Run is disabled when the task's referenced agent is no longer defined (the card shows a *missing* badge) — click the card to open the editor and pick a current agent.

## Create or edit a task

Click **+ New task**, or **click a task card** to open the **editor popup** for an existing task:

- **Name** — the card title. For a new task the **slug** auto-derives from the name until you hand-edit it.
- **Agent** — pick an agent from the [`agents` settings list](agent-clis-and-models.md#register-it-as-a-condash-agent); the select shows the agent's `label` and stores its stable `id`. Only agents with [`promptFlags`](../reference/config.md#agents) are selectable — a task hands its filled prompt to the agent via `--prompt`/`--run`, which an opaque command can't accept. Agents without the flag are shown disabled (a new task defaults to the first prompt-seedable agent). A task already pointing at an opaque agent keeps that selection and still runs via the type-into-tab fallback.
- **Submit** — press Enter after typing (on by default).
- **Prompt** — markdown with `{MARKERS}`. The **Markers** chips below update live as you type so you can see the fields you're creating.

The editor carries **Save** / **Cancel** and, for an existing task, a **Delete** button that asks for confirmation first. Renaming the slug moves the task directory.

## See also

- **[Agent CLIs and model providers](agent-clis-and-models.md)** — define the agents a task references.
- **[The deliverables pane](deliverables-pane.md)** — the other left-band view that shares the edge strip.
- **[The embedded terminal](terminal.md)** — where a running task's agent tab opens.
