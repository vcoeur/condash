# Worked example — helio 0.3

The 0.3 release ran in a two-hour window on 2026-03-20. The one thing that went
wrong is worth remembering: a stale `site/` build was committed over the fresh
one during release-branch cleanup, which took the docs site down for a day.

Rollback story per step: untag, yank the PyPI release, revert the tap commit.
The docs deploy is the only step with no rollback — redeploy the previous tag
instead.
