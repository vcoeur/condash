# Runbook

Operational steps for the daily on-call rotation.

## Morning checklist

- Check the dashboard for overnight alerts.
- Verify the ingestion lag is under 5 minutes.
- Triage any new tickets in the queue.

## Common incidents

- High dirty-page count: see `notes/postgres-tuning.md`.
- Search latency spikes: restart the worker pool via the runner.
