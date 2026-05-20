# The Outputs pane

The Outputs pane is a tab in the **left band, next to Projects** — *not* in the right working-surface slot with Code / Knowledge / Resources / Skills / Logs. The left band carries a `[Projects] [Outputs]` tab strip at the top; click **Outputs** to switch the band to it. Which tab was last active is remembered across launches (the `leftView` layout field).

## What it shows

Every project whose README has a `## Deliverables` section, **grouped by project** (newest first). Each group header shows the project title, a status pill, and the date; expand it to see the project's deliverables.

It is **parse-only**: the pane reuses the deliverables already parsed from each README for the Projects pane — there is no separate filesystem scan and no dedicated `outputs/` directory to maintain. A project appears here the moment it links at least one deliverable, and disappears when it links none.

Each deliverable row carries a coarse type tag derived from the link:

| Tag    | Link |
|--------|------|
| `URL`  | `http(s)://…` |
| `PDF`  | `.pdf` |
| `HTML` | `.html` / `.htm` |
| `MD`   | `.md` / `.markdown` |
| `IMAGE`| `.png` / `.jpg` / `.svg` / … |
| `FILE` | anything else |

## Opening a deliverable

Click a row to open it. The viewer is chosen by type — PDF and HTML preview in-app, URLs open in your browser, Markdown opens read-only, everything else hands off to your OS default app. See **[Deliverables](deliverables.md#how-each-type-opens)** for the full table and the HTML-preview relative-asset notes.

## Empty state

When no project links a deliverable, the pane shows a one-line pointer: link artifacts under a project's `## Deliverables`.

## See also

- **[Deliverables](deliverables.md)** — the `## Deliverables` syntax, accepted link types, and how each opens.
- **[The Resources pane](resources-pane.md)** — the conception-global file browser (right slot), distinct from this per-project aggregation.
