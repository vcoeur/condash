# Dev ports

Which port each service binds locally, and how to unstick a port that's already held.

## Assignments

| Service | Port | Run command |
|---|---|---|
| `helio` API (`cargo run -- serve`) | 8500 | `cargo watch -x 'run -- serve'` |
| `helio-web` (Vite dev server) | 5500 | `npm run dev` |
| `helio-docs` (mkdocs serve) | 8600 | `mkdocs serve` |

We stay out of the common-default ports (3000, 5173, 5432, 8000, 8080) that tend to be held by unrelated tools. Each service owns a dedicated slot in the 8xxx range (and a paired 5xxx for Vite-style frontends) so two demo services can run at the same time without colliding.

## Who holds the port?

```bash
# Linux / macOS
lsof -iTCP:8080 -sTCP:LISTEN

# Alternative if lsof isn't installed
ss -lntp | grep 8080
```

Kill the holder by PID once you've confirmed what it is. If it's a zombie condash runner from a previous session, click **Stop** in the dashboard's inline runner instead — the registry will `SIGTERM` the process group cleanly.

## Why this file is nested two deep

`knowledge/topics/ops/dev-ports.md` sits two subdirectories under `knowledge/`. Before condash v0.12.6 the note-serving endpoint capped at one sublevel, so a file at this path returned `Failed to load note.` when you clicked it. Since v0.12.6 arbitrary depth is served — see [The knowledge tree](https://condash.vcoeur.com/guides/knowledge-tree/).
