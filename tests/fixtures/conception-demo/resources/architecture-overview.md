# Architecture overview

A short reference document about the helio system's architecture. Covers the
ingestion pipeline, the search backend, and the public-facing dashboard.

## Pipeline

The ingestion pipeline reads from S3 and writes to Postgres in batches.

## Search

Queries route through the search backend, which fans out across worker
shards and merges by score.
