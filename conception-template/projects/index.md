# Projects

Items — projects, incidents, documents — live under `projects/YYYY-MM/YYYY-MM-DD-slug/`. The month directory is the item's **creation month**; items never move for their lifecycle. `Status` alone tracks done-ness.

## Kinds

- **project** — feature, planned behaviour change.
- **incident** — bug, outage, unexpected behaviour. Carries `**Environment**` + `**Severity**`.
- **document** — plan, report, investigation, audit. Use only when neither "project" nor "incident" fits.

## Months

_No items yet. Create one with `/projects create <kind>`._

## Read rules

Use `/projects list` for a status-grouped overview, `/projects read <slug>` for an item, `/projects search <keyword>` to grep. The skill is heavyweight — for a one-off note append, edit the file directly.
