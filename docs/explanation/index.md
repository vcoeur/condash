---
title: Explanation · condash
description: Why condash works the way it does — the design commitments, and how the pieces fit under the hood.
---

# Explanation

> **Audience.** New user (curious about why) and Developer (designing or reviewing changes).

Five pages, in roughly the order to read them:

- **[Why Markdown-first](why-markdown.md)** — the pitch. Why files-as-source-of-truth, why no SaaS, why you can put this down as easily as you pick it up.
- **[Values](values.md)** — the design principles every change should serve.
- **[Non-goals](non-goals.md)** — what condash deliberately doesn't do, and why. Read before opening a "while we're at it" PR.
- **[Internals](internals.md)** — the three Electron processes, the IPC contract, the chokidar watcher, the per-file write queue, the PTY kill pipeline. How the pieces hang together.
- **[Contributing](contributing.md)** — clone, build, run, test, ship a change.
