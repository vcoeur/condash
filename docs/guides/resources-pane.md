# The Resources pane

The Resources pane sits next to **Code**, **Knowledge**, and **Skills** in the right working-surface slot (`Ctrl+R` to switch in). It browses the file hierarchy under a configurable directory at the conception root and surfaces every file as a small action card.

## What it shows

By default the pane reads from `<conception>/resources/`. The directory does not have to exist — when it's missing the pane shows an empty-state with a pointer to the setting.

Every file in the tree is rendered, regardless of extension. Hidden dot-files are skipped. Directories at any depth become their own section, so a deeply-nested layout reads as a flat list of grouped sub-directories.

Each card carries a coloured glyph for its file type:

| Glyph | Categories                            |
|-------|---------------------------------------|
| `MD`  | `.md`, `.markdown`                    |
| `PDF` | `.pdf`                                |
| `TXT` | Source code, JSON, YAML, plain text   |
| `IMG` | Images                                |
| `AUD` | Audio                                 |
| `VID` | Video                                 |
| `ZIP` | Archives                              |
| `BIN` | Compiled / opaque binaries            |
| `·`   | Anything else                         |

## Per-card actions

A button row at the bottom of each card exposes:

- **view** — `.md` and `.txt` open in the in-app note modal in **read-only** mode; `.pdf` opens in the existing PDF viewer modal. Any other extension hides this button.
- **open** — opens the file via the user's `open_with.main_ide` slot (configured in `configuration.json`).
- **copy** — copies the absolute path to the system clipboard.
- **→ term** — pastes the absolute path into the focused terminal session (no `↵`). If no session is live, the button still pastes once you spawn one.

Clicking the card body itself runs the most-likely action for the file type — view for inline-viewable types, open-in-IDE otherwise.

## Configuration

Set the directory by editing `configuration.json` at the conception root (per-tree, versioned with the conception), or via **Settings → Workspace → Resources directory**. The value is **not** in `settings.json` — it's tree-side so teammates see the same resources tree.

```json
{
  "resources_path": "resources"
}
```

The value is relative to the conception root. Absolute paths and `..` segments are rejected by the schema.
