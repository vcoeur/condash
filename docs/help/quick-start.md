# Quick start

Three steps: install, point at a folder, create an item.

## 1. Install

Download the latest release for your OS from
**https://github.com/vcoeur/condash/releases/latest**:

| OS | File |
|---|---|
| Linux | `condash-<version>.AppImage` or `condash_<version>_amd64.deb` |
| macOS | `condash-<version>.dmg` |
| Windows | `condash Setup <version>.exe` |

Debian/Ubuntu users can install from the signed apt repository instead:

```bash
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://condash.vcoeur.com/apt/pubkey.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/condash.gpg
echo "deb [signed-by=/etc/apt/keyrings/condash.gpg] https://condash.vcoeur.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/condash.list
sudo apt update && sudo apt install condash
```

The builds are unsigned. Each OS asks you to confirm the download once
on first launch (right-click → Open on macOS; "More info → Run anyway"
on Windows; nothing extra on Linux).

`git` must be on `PATH` — condash shells out to it for repo status.

## 2. First launch

The first time you run `condash`, a **native folder picker** opens and
asks which conception tree to render. Pick (or create) a directory, for
example `~/conception/`. condash writes the choice into `settings.json`
and reuses it next time.

Don't have a folder yet? The minimum is:

```bash
mkdir -p ~/conception/projects
```

If the folder is empty, condash shows a **Welcome screen** with three
buttons:

- **Create your first project** — opens the new-item modal.
- **Take the tour** — opens this Help modal.
- **Open the documentation** — opens condash.vcoeur.com in your browser.

To switch to a different folder later: **File → Open…** (`Ctrl+O`)
opens the folder picker again.

## 3. Create an item

Click **Create your first project** on the Welcome screen, or use the
**Create** button on the Projects toolbar. Fill in:

- **Kind** — `project`, `incident`, or `document`.
- **Status** — `now` so it lands in Current.
- **Title** + **Slug** — the slug is auto-derived from the title.
- **Apps** — optional.

condash writes `projects/<YYYY-MM>/<YYYY-MM-DD>-<slug>/README.md` with
this template:

```markdown
# My title

**Date**: 2026-05-02
**Kind**: project
**Status**: now

## Goal

## Steps

- [ ] (your first step)

## Timeline

- 2026-05-02 — Project created.

## Notes
```

You can also hand-create items — just `mkdir` the folder and drop a
README with that header. condash picks it up live.

## Editing settings

**File → Settings…** (`Ctrl+,`) opens a tabbed modal:

- **General** — theme.
- **Terminal** — shell, shortcuts, xterm.js settings.
- **`configuration.json`** — full JSON editor for the per-tree config
  (atomic save, validated against the schema).
- **Shortcuts** — keyboard reference.

Per-tree config (`<conception>/configuration.json`) is shared with
teammates via git — workspace path, repos, launcher commands. Per-machine
config (`settings.json`) is local to this laptop — your editor binary,
your terminal, your theme.

## More

Full docs (tutorials, per-feature guides, reference) live online at
**https://condash.vcoeur.com**. The Help menu has an **Open documentation
site** entry.
