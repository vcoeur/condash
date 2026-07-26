---
name: release-helio
description: Cut a coordinated helio release across the CLI, the web dashboard, and the docs site — tag order, artifact checks, and the announcement.
---

# release-helio

Ship the three helio repos in one coordinated pass. The order matters: the
Homebrew tap reads the published PyPI artifact, and the docs build regenerates
its flag reference from the tagged CLI.

## Steps

1. Cut a release branch in each repo and update its CHANGELOG.
2. Tag `helio`, publish to PyPI, attach the built artifacts to the Release.
3. Bump `helio-web` to match; publish the image, redeploy the demo.
4. Bump the Homebrew tap; verify `brew upgrade helio` pulls the new version.
5. Rebuild `helio-docs` against the tagged CLI; check the version selector.
6. Send the announcement only once all four are green.

See [the worked example](example.md) for a 0.3-shaped run.
