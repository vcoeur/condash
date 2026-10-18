// Context-bias resolution for dictation (design note 04 §8).
//
// The effective vocabulary is the user's `voice.contextBias` phrases seeded —
// additively, silently — with the open conception's `repositories[]` app
// identity: explicit handles first, else the registry's `appHandle`
// normalisation of the name/path, then display names and legacy aliases. The
// whole list is trimmed, deduplicated (case-insensitively — bias hints are
// spellings, and `Vcoeur`/`vcoeur` carry the same intent), and capped at the
// provider's 100-phrase limit with user phrases taking priority.

import { appHandle } from '../../shared/app-color';

/** The documented provider cap on `context_bias` phrases. */
export const MAX_CONTEXT_BIAS = 100;

/** The shape of a `repositories[]` row this resolver reads — the raw config
 *  entry union: a bare directory name, an object row, or a section marker
 *  (no behaviour — skipped). Keeps the module pure and unit-testable without
 *  dragging the config schema in. */
export type BiasRepoEntry =
  | string
  | { section: string }
  | {
      handle?: string;
      name?: string;
      path?: string;
      aliases?: string[];
    };

/**
 * Merge the user's bias phrases with the conception's app vocabulary:
 * `[user phrases…, handles, names, aliases]`, trimmed, non-empty,
 * deduplicated, capped at 100. User phrases come first so an entry the user
 * typed deliberately is never dropped to the cap in favour of a derived
 * handle. No repositories → the user list unchanged (same filter rules).
 */
export function resolveContextBias(
  userBias: string[] | undefined,
  repositories: BiasRepoEntry[] | undefined,
  handlesOnly = false,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    if (out.length >= MAX_CONTEXT_BIAS) return;
    if (typeof raw !== 'string') return;
    const phrase = raw.trim();
    if (!phrase) return;
    const key = phrase.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(phrase);
  };
  for (const phrase of userBias ?? []) push(phrase);
  for (const repo of repositories ?? []) {
    if (typeof repo === 'string') {
      push(handlesOnly ? appHandle(repo) : repo);
      continue;
    }
    if ('section' in repo) continue;
    push(
      handlesOnly
        ? appHandle(repo.handle ?? repo.name ?? repo.path ?? '')
        : (repo.handle ?? appHandle(repo.name ?? repo.path ?? '')),
    );
    if (!handlesOnly) {
      push(repo.name);
      for (const alias of repo.aliases ?? []) push(alias);
    }
  }
  return out;
}
