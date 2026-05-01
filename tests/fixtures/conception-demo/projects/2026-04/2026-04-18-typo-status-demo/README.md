# Demo: unknown Status value

**Date**: 2026-04-18
**Kind**: project
**Status**: wip
**Apps**: `helio`

## Goal

A deliberately-broken seed item for the docs site: `**Status**: wip` is **not** in the canonical enum (`now` / `review` / `later` / `backlog` / `done`), so condash coerces it to `backlog`, logs a parser warning, and surfaces the red `!?` badge on this card. Point at this card when screenshotting the badge behaviour.

Fix to remove the badge: change `wip` to `now` (or any valid value).

## Steps

- [ ] Keep this item's Status broken as long as the docs reference it
- [ ] If the badge shape changes, reshoot the screenshot referenced from [`docs/reference/readme-format.md`](https://condash.vcoeur.com/reference/readme-format/#status)

## Timeline

- 2026-04-18 — Created as a screenshot fixture.
