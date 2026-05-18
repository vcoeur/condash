---
title: Project actions and starter prompts · condash help
description: How to configure per-project actions and new-project starter prompts that paste into the terminal.
---

# Project actions and starter prompts

> **Audience.** Daily user.

condash can paste pre-written prompts into the focused terminal with one click. There are two places this shows up:

- **Project actions** — a dropdown next to the **Work on** button on every project card.
- **New project actions** — a dropdown next to the **+ New project** button.

Both are configured in **Settings → Terminal** (Global or This conception tab).

## How it works

Each entry has three fields:

- **Label** — what you see in the dropdown.
- **Template** — the text that gets pasted into the terminal. You can use placeholders like `{slug}` or `{today}`; see the tables below.
- **Submit** — when checked, condash presses Enter after pasting. Unchecked means you read the line and confirm yourself (the same behaviour as the built-in **Work on** button).

### Project actions

Project actions accept placeholders drawn from the project you clicked:

| Placeholder   | Value                                                                 |
| ------------- | --------------------------------------------------------------------- |
| `{slug}`      | Full project slug (`2026-05-17-foo-bar`)                              |
| `{shortSlug}` | Slug with the `YYYY-MM-DD-` prefix removed (`foo-bar`)                |
| `{title}`     | Project title                                                         |
| `{branch}`    | Git branch, or empty string if none                                   |
| `{base}`      | Base branch, or empty string if none                                  |
| `{kind}`      | `project`, `incident`, `document`, …                                  |
| `{status}`    | `now`, `review`, `later`, `backlog`, `done`                           |
| `{date}`      | First ten characters of the slug (`2026-05-17`)                       |
| `{apps}`      | Comma-separated app list (`condash, conception`)                      |
| `{firstApp}`  | First app in the list (`condash`)                                     |
| `{path}`      | Absolute project path                                                 |
| `{relPath}`   | Project path relative to the conception root (`projects/2026-05/…`)   |

Plus the global placeholders below (available everywhere).

### New project actions

New project actions only accept the global placeholders — there is no project context yet:

| Placeholder       | Value                                                            |
| ----------------- | ---------------------------------------------------------------- |
| `{today}`         | Local date in `YYYY-MM-DD` format                                |
| `{conception}`    | Basename of the open conception directory (`conception`)         |
| `{conceptionPath}`| Absolute path to the open conception directory                   |

### Typos and unknown placeholders

If you write `{slgu}` instead of `{slug}`, the literal text `{slgu}` is pasted into the terminal so you notice the mistake immediately. Unknown placeholders are never silently dropped.

## The split button

When a list is empty, the button stays exactly as it was before — a single **Work on** icon or a single **+ New project** button. As soon as you add at least one entry, the button grows a caret on the right. The left half keeps the original behaviour; the caret opens the menu.

The menu always shows the original default action at the top (so muscle memory still works), followed by your custom entries in the order you configured them.

## Examples

**Claude review** (project action, `submit: true`):

```json
{ "label": "Claude review", "template": "claude \"review project {shortSlug}\"", "submit": true }
```

**Kimi summary** (project action, `submit: true`):

```json
{ "label": "Kimi summary", "template": "kimi \"summarise branch {branch}\"", "submit": true }
```

**Spec + design starter** (new project action, `submit: false`):

```json
{ "label": "Spec + design starter", "template": "start project for new feature, make spec.md note with functional specification, and design.md note with design plan:", "submit": false }
```

The colon at the end of the starter prompt invites you to type the free-text part before pressing Enter yourself — that is why `submit` is left off (default `false`).

## Settings inheritance

Both lists live under the `terminal` key, so they follow the same inheritance rules as Launchers, font settings, and shortcuts:

- Global settings → applies to every conception you open.
- Conception override → replaces the entire `terminal` block for that conception (same one-level-deep merge as the rest of `terminal`).

You can edit either side from the Settings modal by switching between the **Global** and **This conception** tabs.
