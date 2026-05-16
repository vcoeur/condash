/**
 * Shared bits for the per-noun help text. Each `runNoun` declares its own
 * `printHelp(verb)` and per-verb help blocks; the universal-flag footer is
 * the only piece worth centralising — it changes when a new universal flag
 * lands and we don't want to grep 38 help blocks to update it.
 */
export const UNIVERSAL_FOOTER =
  'Universal: --json, --ndjson, --quiet, --no-color, --conception <path>';
