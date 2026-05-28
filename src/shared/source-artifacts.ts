/**
 * Predicate for file-system litter that must never be treated as a skillspec
 * source file, sibling asset, or agent-config fragment.
 *
 * condash ships its conception template inside a `.deb`; when that package is
 * upgraded, dpkg drops conffile residue (`*.dpkg-new`, `*.dpkg-tmp`, …) next to
 * the originals, and `ucf` / rpm-based repackagings leave their own variants.
 * Editor backups and interrupted atomic writes (condash's own `*.tmp` pattern)
 * are the same class of accident. The skill + agent-config walkers must skip
 * every one of these so the junk never propagates into a conception's
 * `.agents/` source tree.
 *
 * Pure string predicate — safe to import from main, renderer, and the CLI
 * bundle alike.
 */

/** File-name suffixes that mark package-manager / editor / temp litter. */
const IGNORED_SUFFIXES: readonly string[] = [
  // dpkg conffile handling — the case that motivated this (condash ships .deb).
  '.dpkg-new',
  '.dpkg-old',
  '.dpkg-dist',
  '.dpkg-tmp',
  '.dpkg-bak',
  // Debian ucf-managed conffiles.
  '.ucf-new',
  '.ucf-old',
  '.ucf-dist',
  // rpm-based repackagings.
  '.rpmnew',
  '.rpmsave',
  '.rpmorig',
  // patch / merge residue.
  '.orig',
  '.rej',
  // editor + generic backups.
  '.bak',
  '.swp',
  '~',
  // interrupted atomic writes (condash's writeFileMkdir tmp suffix, generic .tmp).
  '.tmp',
];

/**
 * True when `name` (a bare file name, not a path) is package-manager, editor,
 * or temp-file litter that should be excluded from any source-tree walk.
 */
export function isIgnoredSourceArtifact(name: string): boolean {
  return IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
