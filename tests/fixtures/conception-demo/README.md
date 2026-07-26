# conception-demo

A throwaway conception tree used purely to generate the screenshots for the condash documentation site. Nothing here refers to real work — it describes an imaginary CLI project called **helio** and its two companions (`helio-web`, `helio-docs`).

The tree intentionally exercises every condash surface:

- Projects across two months (`2026-03`, `2026-04`) covering all five statuses: `now`, `review`, `later`, `backlog`, `done` — plus one deliberate non-canonical status so the warn badge renders.
- All three item kinds: `project`, `incident`, `document`.
- Items with and without `branch:`, single-app and multi-app.
- Step lists combining `[ ]`, `[~]`, `[x]`, and `[-]` markers.
- `## Deliverables` sections covering every type tag: `WIKI`, `URL`, `PDF`, `MD`, `IMAGE`, `FILE`.
- Wikilinks (`[[slug]]` / `[[slug|label]]`) cross-linking projects to incidents and documents.
- A `knowledge/` tree with `conventions.md`, per-topic files, and per-repo internal files.
- A `notes/NN-<slug>.mdx` visual plan for the MDX viewer.
- `tasks/<slug>/{task.json,prompt.md}` for the Tasks pane.
- `AGENTS.md` + `.agents/skills/` for the Skills pane.

## What lives where

`.condash/settings.json` is the canonical per-conception config and holds **only** the keys a tree owns: `workspace_path`, `worktrees_path`, `repositories`, `taskConfig`. Personal / per-machine keys (`agents`, `terminal`, `open_with`, `pdf_viewer`) belong in the user's `settings.json`; the harness seeds them there (`demoGlobalSettings` in `tests/screenshots.spec.ts`), because a conception tree never describes an agent list or a shell.

## Pointing condash at this tree

The screenshot harness copies this directory to a throwaway location, `git init`s the repos its `repositories` list names so the Code pane has real branches and a real dirty count, and points a throwaway `XDG_CONFIG_HOME` at the result. To browse the tree by hand instead, copy it somewhere writable and open the copy — condash's first boot writes to `.condash/`.

## Regenerating

This tree is hand-written. There is no automation and it is not expected to be kept in sync with the real conception repo. If condash's parser grows a new required field, update the fixture manually and re-run `npm run test -- --reporter=list screenshots.spec.ts`.
