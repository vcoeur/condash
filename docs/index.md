# condash documentation

Reference material for the condash (Electron) build. The CLAUDE.md at the repo root is the operating-instructions surface; this directory is for the durable architectural and configuration knowledge that informs day-to-day work.

## Contents

- [`architecture.md`](architecture.md) — load-bearing invariants: drift-checked mutations, atomic-rename writes, the per-file write queue, the TTL git-status cache, the SIGTERM → force_stop → SIGKILL pty pipeline, the IPC contract.
- [`configuration.md`](configuration.md) — `<conception>/configuration.json` reference: every key, with examples and edit paths.
- [`non-goals.md`](non-goals.md) — what condash will deliberately not do. Read before adding "while we're at it" features.

## Why a `docs/` tree

condash is shipped with `electron-builder`; users don't get a source tree, only the packaged app. The `docs/` files are bundled into the asar at package time so the in-app Help menu can render them through the existing markdown pipeline. The same files also serve as the public reference for anyone hand-editing `configuration.json` or contributing to the codebase.

## Editing rules

- Every code change that touches a behaviour described here updates the relevant doc in the same commit. The repo `CLAUDE.md` enforces this.
- `architecture.md` describes invariants, not the implementation. If you need to update it after a refactor, the change is probably wrong — refactors should preserve the invariants.
- `configuration.md` is the public contract for `configuration.json`. Removing or renaming a key is a breaking change; add migration notes if you must.
- `non-goals.md` is append-only. Don't soften an existing non-goal; open an issue if you think one needs revisiting.
