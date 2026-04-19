# Starter conception tree

This is a minimum working `conception/` tree for [`condash`](https://condash.vcoeur.com/). Copy it to a working location (for example `~/conception/`), point `condash` at it, and you have a functioning dashboard with three example items.

```
~/conception/
├── README.md                                       ← this file (optional — condash ignores it)
└── projects/
    └── 2026-04/
        ├── 2026-04-15-first-project/
        │   └── README.md    (**Kind**: project)
        ├── 2026-04-15-first-incident/
        │   └── README.md    (**Kind**: incident)
        └── 2026-04-15-first-document/
            └── README.md    (**Kind**: document)
```

Every item lives under `projects/YYYY-MM/YYYY-MM-DD-<slug>/`. The three kinds — project, incident, document — all share that one flat layout; the `**Kind**` field in the README header is what tells them apart. See [README format](https://condash.vcoeur.com/reference/readme-format/) for the full header schema.

## Install and use

```bash
# 1. Copy this starter to where you want your real tree.
mkdir -p ~/conception
cp -r /path/to/condash/examples/conception-starter/* ~/conception/

# 2. Point condash at it.
condash init
condash config edit                  # set conception_path = "/home/<you>/conception"

# 3. Launch.
condash
```

The three example items appear in the dashboard in different kanban columns (`now`, `now`, `review`). Click any item to expand it; try toggling a step with a click.

## Next

- Edit the three example READMEs to match your real work, or delete them and replace with your own. Everything the dashboard knows is re-parsed from the files on every refresh.
- Read the [Status, steps, deliverables](https://condash.vcoeur.com/reference/conception-convention/) reference for the full body-level syntax (`## Steps`, `## Timeline`, `## Deliverables`).
- Install the [management skill](https://condash.vcoeur.com/reference/skill/) so Claude Code can create, update, and close items for you.
