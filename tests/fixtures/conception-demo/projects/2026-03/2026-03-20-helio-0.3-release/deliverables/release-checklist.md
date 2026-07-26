# helio 0.3 release checklist

The order matters: the tap bump reads the PyPI artifact, and the docs build
reads the tagged CLI to regenerate the flag reference.

1. `helio` — changelog, tag `v0.3.0`, GitHub Release, PyPI upload.
2. `helio-web` — bump to match, publish the Docker image, redeploy the demo.
3. Homebrew tap — bump the formula, verify `brew upgrade helio`.
4. `helio-docs` — rebuild against the tagged CLI, update the version selector.
5. Announcement email, once all four are green.

Rollback: untag, yank the PyPI release, revert the tap commit. The docs site is
the only step with no rollback — redeploy the previous tag instead.
