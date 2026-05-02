# Quick start

Three steps: install, point at a folder, start working.

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
on Windows; nothing extra on Linux). Full per-OS walkthrough is online.

`git` must be on `PATH` — condash shells out to it for repo status.

## 2. First launch — pick a conception folder

The first time you launch condash, a folder picker opens. Choose (or
create) a directory that will hold your Markdown items, for example
`~/conception/`. condash stores that path and reuses it next time.

What goes in that folder:

- `projects/YYYY-MM/YYYY-MM-DD-<slug>/README.md` — one folder per item
  (project, incident, or document).
- `knowledge/` — your reference notes, organised as a tree.
- `configuration.json` — workspace + preferences (see "Configuration"
  in this Help menu).

The dashboard auto-creates `projects/` and `knowledge/` if they don't
exist. `configuration.json` is created with sensible defaults the first
time you open the gear modal and save.

## 3. Create your first item

Easiest path: in the **Projects** tab, click **Create** in the toolbar,
fill in title + slug, pick a status. condash writes a `README.md` with
the right header and opens it for editing.

You can also create items by hand — just make a folder under
`projects/<YYYY-MM>/` and drop a `README.md` with this header:

```markdown
# My title

**Date**: 2026-05-02
**Kind**: project
**Status**: now
**Apps**: `myapp`
```

condash picks it up on the next file-system event.

## More

- **Tutorials** (online): https://condash.vcoeur.com/tutorials/
- **Guides** (online, per-feature how-tos): https://condash.vcoeur.com/guides/
