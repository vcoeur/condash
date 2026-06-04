/**
 * Shared bits for noun dispatch + per-noun help text.
 *
 * `runNoun` collapses the dispatch boilerplate every verb-based noun runner
 * used to copy verbatim: the `verb === 'help'` and universal `--help`
 * triggers, the null-verb "print help" case, and the unknown-verb USAGE
 * throw. `renderHelp` collapses the per-noun help render — appending the
 * universal-flag footer that previously lived inline in ~9 `printHelp`
 * functions (the one piece that changes when a new universal flag lands).
 */
import { CliError, ExitCodes } from './output';
import type { ParsedArgs } from './parser';

export const UNIVERSAL_FOOTER =
  'Universal: --json, --ndjson, --quiet, --no-color, --conception <path>';

/**
 * Render a help block: the given lines, a blank line, the universal-flag
 * footer, and a trailing newline. Centralised so adding a universal flag is a
 * one-line edit here rather than a grep across every noun's help text.
 *
 * @param lines the noun/verb-specific usage lines (no footer, no trailing gap)
 */
export function renderHelp(lines: readonly string[]): string {
  return [...lines, '', UNIVERSAL_FOOTER, ''].join('\n');
}

/**
 * Run a verb-based noun: handle the help/null/unknown dispatch uniformly,
 * then call the matching handler from `verbs`.
 *
 * Behaviour, identical to the hand-rolled heads it replaces:
 *  - `verb === 'help'`  → `printHelp(args.positional[0] ?? null)` (the
 *    `condash <noun> help <verb>` form forwards the sub-verb).
 *  - `universalHelp`    → `printHelp(verb)` (the `--help` flag path).
 *  - `verb === null`    → `printHelp(null)`.
 *  - a key in `verbs`   → await that handler.
 *  - anything else      → `CliError(USAGE, "Unknown <noun> verb: <verb>")`.
 *
 * @param noun the noun name, used only for the unknown-verb error message
 * @param verb the parsed verb (may be null)
 * @param args the parsed args, forwarded to the handler
 * @param verbs map of verb name → handler (handlers close over ctx/path)
 * @param printHelp renders help for a verb (or null for the noun overview)
 * @param universalHelp whether the universal `--help` flag was set
 */
export async function runNoun(
  noun: string,
  verb: string | null,
  args: ParsedArgs,
  verbs: Record<string, () => Promise<void> | void>,
  printHelp: (verb: string | null) => void,
  universalHelp: boolean,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }
  if (verb === null) {
    printHelp(null);
    return;
  }
  const handler = verbs[verb];
  if (!handler) {
    throw new CliError(ExitCodes.USAGE, `Unknown ${noun} verb: ${verb}`);
  }
  await handler();
}
