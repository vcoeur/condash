# Welcome to your conception

This folder is a **conception**: a Markdown tree that condash manages and renders.
The files in here are the source of truth — condash is the live view on top of
them, and it never overwrites what you write by hand.

## The shape

- `projects/` — dated work items: one folder per project, incident, or document,
  at `projects/YYYY-MM/YYYY-MM-DD-slug/README.md`. The README is the unit of
  tracking; findings and analysis live next to it under `notes/`.
- `knowledge/` — durable reference material: conventions, internal notes, and
  topics, each self-describing through its `index.md`.
- `.agents/skills/` — the condash skills (`projects`, `knowledge`, `pr`,
  `applications`, `visual`) as agent-facing instruction files, refreshed by
  `condash skills install`.
- `AGENTS.md` — instructions for AI coding agents working in this tree. condash
  owns the `## General` section and rewrites it on skill installs; your own
  content goes in `## Specifics` below the marker, which condash never touches.
- `.condash/` — per-conception settings and logs (gitignored by default).

## How to start

- Open condash and pick this folder.
- Create your first item with the **New project** button in the app, or run
  `condash projects create` from the command line.
- A project's `Status` alone tracks done-ness: it is `now` while active,
  `review` once work ships and awaits a signal, `done` when that signal lands.

Everything you do in condash is a change to these files, and every change to
these files shows up in condash.
