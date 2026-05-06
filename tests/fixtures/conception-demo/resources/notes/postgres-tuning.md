# Postgres tuning notes

Background notes captured during the 2026-Q1 ingestion-perf project.

## work_mem

Bumped from the default to 64 MB after profiling the merge-join hot path.

## shared_buffers

Default 25 % of RAM is fine on the current host class.
