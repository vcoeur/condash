# The Resources pane

The Resources pane sits next to **Code**, **Knowledge**, and **Skills** in the right working-surface slot (`Ctrl+R` to switch in). It browses the file hierarchy under a configurable directory at the conception root and surfaces every file as a small action card.

![Resources pane — file cards grouped by directory with view/open/copy/→term actions](../assets/screenshots/resources-pane-light.png#only-light)
![Resources pane — file cards grouped by directory with view/open/copy/→term actions](../assets/screenshots/resources-pane-dark.png#only-dark)

## What it shows

By default the pane reads from `<conception>/resources/`. The directory does not have to exist — when it's missing the pane shows an empty-state with a pointer to the setting.

Every file in the tree is rendered, regardless of extension. Hidden dot-files are skipped. Directories at any depth become their own section, so a deeply-nested layout reads as a flat list of grouped sub-directories.

Each card carries a coloured glyph for its file type:

| Glyph | Categories                            |
|-------|---------------------------------------|
| `MD`  | `.md`, `.markdown`                    |
| `PDF` | `.pdf`                                |
| `WEB` | `.html`, `.htm`                       |
| `TXT` | Source code, JSON, YAML, plain text   |
| `IMG` | Images (raster + SVG)                 |
| `AUD` | Audio                                 |
| `VID` | Video                                 |
| `ZIP` | Archives                              |
| `BIN` | Compiled / opaque binaries            |
| `·`   | Anything else                         |

## Per-card actions

A button row at the bottom of each card exposes:

- **view** — opens the file in-app, picking the viewer by type:
    - Markdown → the note modal, rendered, **read-only**.
    - Text / source code (JSON, YAML, CSS, JS, …) → the note modal, **read-only**, syntax-highlighted by extension.
    - PDF → the PDF viewer modal.
    - HTML → the HTML viewer modal, rendered, with a **Rendered / Source** toggle in the header.
    - Image (raster or SVG) → the image viewer modal, fit-to-window.
    - Audio, video, archives and binaries have no in-app viewer — the button is hidden and the card opens them in the OS default app instead.
- **open** — opens the file via the user's `open_with.main_ide` slot (configured in `.condash/settings.json`, or the legacy `condash.json`).
- **reveal** — reveals the file in your OS file manager (selected in its parent folder).
- **copy** — copies the absolute path to the system clipboard.
- **→ term** — pastes the absolute path into the focused terminal session (no `↵`). If no session is live, the button still pastes once you spawn one.

Clicking the card body itself runs the most-likely action for the file type — view for inline-viewable types, open-in-IDE otherwise.

Each in-app viewer (PDF, HTML, image) carries the same reveal + open-in-OS escape hatches in its header, so a file that can't render in-app (e.g. an HTML page pulling root-absolute or remote assets, or an image outside the conception tree) is always one click from the real application.

## Configuration

The Resources pane reads `<conception>/resources/` unconditionally — the directory name is hard-coded and not configurable. To opt out, leave the directory absent; the pane renders an empty state.
