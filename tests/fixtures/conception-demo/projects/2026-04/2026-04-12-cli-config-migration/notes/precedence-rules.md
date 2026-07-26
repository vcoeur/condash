# Precedence rules for the layered TOML config

Four layers, merged lowest-to-highest at load time. A key set in a higher layer
replaces the same key from every lower one; tables merge key-by-key, arrays do
not merge (the highest layer's array wins wholesale).

| # | Layer | Path |
|---|-------|------|
| 1 | System defaults | `/etc/helio/config.toml` |
| 2 | User config | `$XDG_CONFIG_HOME/helio/config.toml` |
| 3 | Project override | `./.helio.toml`, searched upwards to the repo root |
| 4 | Environment | `HELIO_<SECTION>_<KEY>` |

## Worked example

With `search.engine = "legacy"` in the user config and `HELIO_SEARCH_ENGINE=trigram`
in the environment, the effective value is `trigram` — layer 4 beats layer 2.

With `search.exclude = ["*.gz"]` in the user config and `search.exclude = ["*.zst"]`
in the project override, the effective value is `["*.zst"]` — arrays replace, they
never concatenate. That was the single most surprising rule in beta feedback, so
`helio config explain <key>` prints the winning layer for every key.
