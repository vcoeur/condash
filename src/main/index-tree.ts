/**
 * Index-tree regenerator — shared engine for `condash projects index` and
 * `condash knowledge index`.
 *
 * Both trees follow the same contract: every directory carries an `index.md`
 * listing its immediate `.md` files (excluding `index.md`) and its immediate
 * subdirectories. Every entry is a single bullet:
 *
 *   - [`name`](link) — *one-line italic description.* `[k1, k2, …]`
 *
 * Hand-written sections (intros, "Read rules", "Bucket-picking rubric", …)
 * are preserved verbatim. The engine mutates only the **bullet list** inside
 * recognised "bullet sections" — sections whose existing content is bullets
 * pointing at children of the directory.
 *
 * Idempotence guarantees:
 *  - Same tree contents → zero diff. Every existing entry whose target still
 *    exists is kept verbatim (description and tags untouched) when curated.
 *  - Curated description / keyword edits survive across runs. To change them,
 *    edit the index entry directly; the engine never overwrites.
 *  - Drafted-vs-curated distinction: every bullet the engine writes carries
 *    a trailing `<!-- draft -->` HTML-comment marker. Removing the marker
 *    promotes the bullet to "curated" — the engine stops touching it. Adding
 *    or keeping the marker keeps the bullet under engine ownership: tags are
 *    re-derived from the current source on every run (for file bullets the
 *    description is re-derived too — the whole bullet is engine-owned), junk
 *    is filtered out, and the aggregated tag list is capped at 8
 *    (`TARGET_MAX`). Surplus candidates are reported via `overTagDropped`.
 *  - `--rewrite-aggregated` mode (one-shot migration): treats every existing
 *    subdir bullet as drafted for the duration of the run, then re-derives
 *    its tags from current source and adds the marker. Used to clean a tree
 *    that was polluted by the legacy "set union, no drops" aggregator.
 *
 * Trailing HTML comments — the engine recognises exactly ONE trailing
 * comment on a bullet: the end-anchored `<!-- draft -->` marker:
 *  - Re-deriving an engine-owned row (drafted or loose) emits
 *    `body + tag block + marker`. Any other trailing comment on such a row
 *    is dropped: the marker flags the row as auto-managed, so the engine
 *    owns the whole line.
 *  - Curated rows (marker absent) are never rewritten — a human annotation
 *    like `<!-- TBC -->` on a curated row survives indefinitely and is the
 *    supported home for annotations.
 *  - Interior HTML comments inside a description are description text —
 *    never parsed, never touched.
 *  - A row whose `<!-- draft -->` token is not at line end parses as
 *    curated and is never rewritten.
 *
 * Strategy interface plugs in the per-tree drafting heuristic (how to read a
 * new file's body and propose a description + keywords) and the optional
 * pre-pass validator (projects has one; knowledge doesn't).
 */

import { constants, promises as fs, type BigIntStats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { toPosix } from '../shared/path';
import { iterUnfencedLines } from '../shared/header';
import { atomicWrite } from './atomic-write';
import { isLowQualityTag } from './index-tag-filter';
import { detectEol, withFileQueue } from './mutate-shared';

/** Per-bullet aggregated-tag cap. Surplus is dropped and surfaced in overTagDropped. */
const TARGET_MAX = 8;

/** HTML-comment marker rendered on every engine-drafted bullet. */
const DRAFT_MARKER = '<!-- draft -->';
/** The draft marker, end-anchored: only a marker at the very end of the line
 * counts. A row whose marker sits elsewhere parses as curated. */
const DRAFT_MARKER_RE = /\s+<!--\s*draft\s*-->\s*$/;
/** One HTML comment, end-anchored. The tempered dot cannot cross an earlier
 * `-->`, so only a true trailing comment — the one whose `-->` sits at line
 * end — matches; an interior comment inside prose can never be reached.
 * Stripped one at a time from the line end, parse-side only; the engine
 * never preserves or re-emits such comments. */
const TRAILING_COMMENT_RE = /\s+<!--(?:(?!-->).)*-->\s*$/;

// ---------------------------------------------------------------------------
// Public report shape.
// ---------------------------------------------------------------------------

export interface IndexRegenReport {
  tree: 'projects' | 'knowledge';
  rootPath: string;
  /** index.md files we created from scratch (no prior file existed). */
  created: string[];
  /** index.md files we rewrote with at least one bullet add/drop/tag-add. */
  updated: UpdateRow[];
  /** Index files we read but had no diff to write — proves idempotence. */
  unchanged: string[];
  /** "Folder X is gone but its bullet still pointed at it" — surfaces in a
   * suspected-rename block when a similarly-named on-disk entry appeared. */
  flaggedRenames: RenameFlag[];
  /** Per-tree validation warnings (currently: project header drift). */
  validationWarnings: ValidationWarning[];
  /** Subdir bullets that hit the `TARGET_MAX` aggregation cap; lists the
   * tags that didn't make the cut so a human can promote one to curated. */
  overTagDropped: { indexPath: string; entry: string; dropped: string[] }[];
  /** Whether the tree's `.index-dirty` marker was cleared. */
  dirtyClear: boolean;
  /** True when called with --dry-run; nothing was written. */
  dryRun: boolean;
  /** True when called with --rewrite-aggregated; surfaces in CLI output. */
  rewriteAggregated: boolean;
}

export interface UpdateRow {
  indexPath: string;
  added: string[];
  dropped: string[];
  tagsAdded: { entry: string; tags: string[] }[];
}

export interface RenameFlag {
  indexPath: string;
  /** The entry whose target disappeared. */
  oldName: string;
  /** Candidate new name found in the same directory. */
  newName: string;
}

export interface ValidationWarning {
  path: string;
  field: string;
  message: string;
  severity: 'error' | 'warn';
}

/** Recovery-only input validation; paths are absolute and absence is significant. */
export interface IndexRecoveryInput {
  path: string;
  kind: 'directory' | 'output' | 'source' | 'readme' | 'marker';
}

/** An actual render result, delivered under the output's file queue. */
export interface IndexRecoveryOutput {
  path: string;
  input: Buffer | null;
  proposed: Buffer;
  changed: boolean;
  renames: readonly RenameFlag[];
}

/** A marker operation delivered under its file queue, including absent clears. */
export interface IndexRecoveryMarker {
  path: string;
  input: Buffer | null;
  proposed: Buffer | null;
}

/** Internal recovery extension; callbacks must finish strict persistence before resolving. */
export interface IndexRecoveryLifecycle {
  validateInput(input: IndexRecoveryInput): Promise<void>;
  /** Own validation, intent, strict write (only when changed), and completion; no ordinary writer runs. */
  applyOutput(output: IndexRecoveryOutput): Promise<void>;
  /** Own marker intent/write or unlink/durability/completion; null proposed bytes mean clear. */
  applyMarker(marker: IndexRecoveryMarker): Promise<void>;
}

/** Output paths and conservative direct inputs, including recursion-skipped child indexes. */
export interface IndexPathEnumeration {
  outputs: string[];
  inputs: string[];
}

// ---------------------------------------------------------------------------
// Strategy: per-tree drafting.
// ---------------------------------------------------------------------------

export interface IndexStrategy {
  treeName: 'projects' | 'knowledge';
  /**
   * Root subdirectory under `<conceptionPath>` to walk. `'projects'` or
   * `'knowledge'`.
   */
  rootDirName: 'projects' | 'knowledge';
  /**
   * Format the link target for a child entry. Knowledge: dirs → `name/index.md`,
   * files → `name`. Projects: depends on the parent dir — at the projects root,
   * months link to `name/index.md`; at a month dir, items link to `name/README.md`
   * (item folders don't carry an index.md).
   */
  formatChildLink: (parentDirAbsPath: string, child: ChildInfo) => string;
  /**
   * Draft a description + keyword list for a new file entry. Strategy-chosen
   * read of `child.absPath`.
   */
  draftFileEntry: (parentDirAbsPath: string, child: ChildInfo) => Promise<DraftResult>;
  /**
   * Draft a description + keyword list for a new subdir entry. The strategy
   * decides which inner file to lift content from (knowledge: `index.md`;
   * projects items: `README.md`).
   */
  draftSubdirEntry: (
    parentDirAbsPath: string,
    child: ChildInfo,
    aggregatedKeywords: string[],
  ) => Promise<DraftResult>;
  /**
   * Optional pre-pass validation. For projects this returns header
   * warnings/errors per README; for knowledge it returns nothing.
   */
  preValidation?: (rootAbsPath: string, conceptionPath: string) => Promise<ValidationWarning[]>;
  /**
   * Initial template emitted when a directory has no `index.md` yet. The
   * engine appends bullet sections after the template body.
   */
  initialTemplate: (relPath: string) => string;
}

export interface DraftResult {
  description: string;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

export interface ChildInfo {
  kind: 'file' | 'directory';
  name: string;
  absPath: string;
}

interface BulletEntry {
  /** Name as it appears in the link text (e.g. `subdir/` or `foo.md`). */
  name: string;
  /** Original raw bullet line, exactly as it appeared. */
  raw: string;
  /** Tags parsed out of the bullet (empty when the bullet has none). */
  tags: string[];
  /** Section heading the bullet currently lives under. */
  sectionHeading: string;
  /** True when the bullet carries a trailing `<!-- draft -->` marker — the
   * engine owns it and may rewrite tags on subsequent runs. False = curated. */
  draft: boolean;
  /** True when the bullet matched only the loose recovery regex — the
   * description / tag-block portion is malformed (e.g. the historical
   * bracket-in-description bug). The engine re-renders the line from a
   * fresh draft on the next pass to repair the shape. */
  loose: boolean;
}

interface IndexFileShape {
  /** Lines of the file split by \n, no trailing newline tracking. */
  lines: string[];
  /** Dominant line ending of the source file — re-used by `renderIndex` so a
   * CRLF-authored index isn't flipped to LF wholesale on regen. */
  eol: '\n' | '\r\n';
  /** Sections in order: name + the line-range they own (start = heading line, end = exclusive). */
  sections: SectionRange[];
  /** Existing bullets, keyed by name (canonical link-text form). */
  bullets: Map<string, BulletEntry>;
  /** True when at least one duplicate bullet line was skipped during parse —
   * the rest of the engine uses this to force a render so the duplicates
   * are physically removed from disk (otherwise an unchanged tag set
   * would let the file slip past the `changed` gate). */
  hadDuplicates: boolean;
  /** Line indexes that are engine-parseable (not inside a ```/~~~ fence and
   * not a fence-toggle line) — the same prose/structure split `parseIndex`
   * used to collect `bullets`. `renderIndex` reuses it so the bullet-block
   * scan can never treat fenced content as structure. */
  unfenced: Set<number>;
}

interface SectionRange {
  /** Heading text (no leading `## `). For the implicit pre-heading prologue
   * we use the empty string. */
  heading: string;
  /** Heading line index (0-based). -1 for the prologue. */
  headingLine: number;
  /** First content line after the heading. */
  contentStart: number;
  /** First line of the next heading (exclusive end of this section's content). */
  contentEnd: number;
  /** Section "kind" inferred from existing bullets: dirs, files, mixed, empty. */
  kind: 'dir' | 'file' | 'mixed' | 'empty';
}

// Bullet line: `- [`name`](link) — *description.* `[t1, t2, …]``
//
// Description capture is greedy on purpose: descriptions in the wild contain
// literal `*` characters (env-var prefixes `KNOTEN_*`, glob patterns
// `@xterm/addon-*`, version specifiers `v*`). A non-greedy `[^*]+` would
// truncate at the first such star and the bullet would stop matching, the
// engine would think the entry was missing, and would helpfully append a
// duplicate. So we require the bullet to end with a backtick-tag block (or
// nothing), and let the description swallow internal asterisks.
const BULLET_WITH_TAGS_RE =
  /^-\s+\[(?:`?)(?<name>[^\]`]+?)(?:`?)\]\((?<link>[^)]+)\)\s*[—\-]\s*\*(?<desc>.+)\*\.?\s*`\[(?<tags>[^\]]*)\]`\s*$/;
const BULLET_NO_TAGS_RE =
  /^-\s+\[(?:`?)(?<name>[^\]`]+?)(?:`?)\]\((?<link>[^)]+)\)\s*[—\-]\s*\*(?<desc>.+)\*\.?\s*$/;
// Loose recovery: just the `- [name](link)` head, no description or tag block.
// Used to identify malformed bullets so the engine can de-duplicate them and
// re-render the line from a fresh draft instead of treating the folder as
// "missing" and appending yet another copy.
const BULLET_LOOSE_RE = /^-\s+\[(?:`?)(?<name>[^\]`]+?)(?:`?)\]\((?<link>[^)]+)\)/;
const HEADING2_RE = /^##\s+(.+?)\s*$/;

/**
 * A bullet is engine-owned only when its link points at an immediate child
 * of the directory: a bare name (`foo.md`, `subdir/`), `subdir/index.md`, or
 * `item/README.md`. URLs, anchors, absolute paths, `../` escapes, and deeper
 * relative paths are hand-written cross-references — the engine passes them
 * through verbatim like prose (the "hand-written sections preserved
 * verbatim" contract in the module header). A bullet carrying the
 * `<!-- draft -->` marker stays engine-owned regardless, since only the
 * engine writes the marker.
 */
function isImmediateChildLink(link: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) return false; // scheme — http:, mailto:, …
  if (link.startsWith('/') || link.startsWith('#')) return false;
  const segments = link
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0 || segments.includes('..')) return false;
  if (segments.length === 1) return true;
  return segments.length === 2 && (segments[1] === 'index.md' || segments[1] === 'README.md');
}

function matchBullet(line: string): {
  name: string;
  link: string;
  desc: string;
  tags: string;
  draft: boolean;
  loose: boolean;
} | null {
  // Detect (and strip) the trailing `<!-- draft -->` marker before running
  // the existing bullet regexes — keeps the regexes blissfully unaware of
  // the marker. Any other trailing HTML comment (e.g. a curated
  // `<!-- TBC -->`) is also stripped for MATCHING ONLY so the bullet still
  // parses; both strips are end-anchored, so an interior `<!-- ... -->`
  // inside a description can never be matched or sliced. The comments live
  // in `bullet.raw`; the engine never rewrites them.
  const draft = DRAFT_MARKER_RE.test(line);
  let stripped = draft ? line.replace(DRAFT_MARKER_RE, '') : line;
  while (TRAILING_COMMENT_RE.test(stripped)) {
    stripped = stripped.replace(TRAILING_COMMENT_RE, '');
  }
  const a = stripped.match(BULLET_WITH_TAGS_RE);
  if (a)
    return {
      name: (a.groups as { name: string }).name,
      link: (a.groups as { link: string }).link,
      desc: (a.groups as { desc: string }).desc,
      tags: (a.groups as { tags: string }).tags,
      draft,
      loose: false,
    };
  const b = stripped.match(BULLET_NO_TAGS_RE);
  if (b)
    return {
      name: (b.groups as { name: string }).name,
      link: (b.groups as { link: string }).link,
      desc: (b.groups as { desc: string }).desc,
      tags: '',
      draft,
      loose: false,
    };
  const c = stripped.match(BULLET_LOOSE_RE);
  if (c)
    return {
      name: (c.groups as { name: string }).name,
      link: (c.groups as { link: string }).link,
      desc: '',
      tags: '',
      draft,
      loose: true,
    };
  return null;
}

/** Remove only strict, unfenced drafted child rows for a conservative three-way human-content merge. */
export function indexHumanContent(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const unfenced = new Set(Array.from(iterUnfencedLines(lines), ({ index }) => index));
  return lines
    .filter((line, index) => {
      if (!unfenced.has(index)) return true;
      // The renderer's tolerant parser strips extra comments; recovery must not
      // mistake their normalization for proof that human annotations are disposable.
      const body = line.replace(DRAFT_MARKER_RE, '');
      if (body.includes('<!--') || body.includes('-->')) return true;
      const bullet = matchBullet(line);
      return !bullet?.draft || bullet.loose || !isImmediateChildLink(bullet.link.trim());
    })
    .join(detectEol(raw));
}

/**
 * Run the regenerator over one tree (projects or knowledge). Returns a
 * structured report. Atomic per-file writes; either every change lands or
 * the tree is untouched (failures bubble up after partial writes — same
 * trade-off as every other condash mutation).
 */
export async function regenerateIndex(
  conceptionPath: string,
  strategy: IndexStrategy,
  options: {
    dryRun?: boolean;
    rewriteAggregated?: boolean;
    /** Canonical NEW item names that are confirmed renames (the caller
     *  performed the move itself — `projects rename`). Without this, a moved
     *  item's new name is only ever *flagged* as a suspected rename — the
     *  pass refuses to draft its bullet and leaves the whole directory
     *  untouched — so the item stays missing from its index. A confirmed
     *  name IS drafted in the same pass (old bullet dropped, new bullet
     *  added); the flag still surfaces in `flaggedRenames` for visibility.
     *  Entries may carry the directory trailing slash or not. */
    confirmedRenames?: ReadonlySet<string>;
    /** Inactive in ordinary callers; recovery supplies its own strict queued writer. */
    recovery?: IndexRecoveryLifecycle;
  } = {},
): Promise<IndexRegenReport> {
  const dryRun = options.dryRun === true;
  const rewriteAggregated = options.rewriteAggregated === true;
  const rootPath = join(conceptionPath, strategy.rootDirName);
  const recovery = options.recovery;
  if (recovery && dryRun) throw new Error('Recovery lifecycle cannot run in dry-run mode');
  await recovery?.validateInput({ path: resolve(rootPath), kind: 'directory' });

  const report: IndexRegenReport = {
    tree: strategy.treeName,
    rootPath,
    created: [],
    updated: [],
    unchanged: [],
    flaggedRenames: [],
    validationWarnings: [],
    overTagDropped: [],
    dirtyClear: false,
    dryRun,
    rewriteAggregated,
  };

  try {
    await fs.access(rootPath);
  } catch (error) {
    if (recovery && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return report;
  }

  if (strategy.preValidation) {
    if (recovery) {
      for (const path of await projectValidationInputs(conceptionPath, recovery)) {
        await recovery.validateInput({ path, kind: 'readme' });
      }
    }
    report.validationWarnings = await strategy.preValidation(rootPath, conceptionPath);
  }

  // Collect every directory under root, then process leaves first so a parent
  // index can lift the just-written subdir's intro for its draft.
  const allDirs = await listAllDirectories(rootPath, recovery);
  allDirs.sort((a, b) => b.length - a.length); // deepest first

  // Per-subtree aggregated keyword frequency map, populated bottom-up. The
  // count tracks how many descendant bullets surfaced the tag — used to rank
  // candidates when the cap forces us to drop some.
  const aggregatedKeywords = new Map<string, Map<string, number>>();

  for (const dir of allDirs) {
    const result = await processDirectory(
      dir,
      conceptionPath,
      strategy,
      aggregatedKeywords,
      dryRun,
      rewriteAggregated,
      options.confirmedRenames,
      recovery,
    );

    if (result.created) report.created.push(result.indexPath);
    else if (result.changed) {
      report.updated.push({
        indexPath: result.indexPath,
        added: result.added,
        dropped: result.dropped,
        tagsAdded: result.tagsAdded,
      });
    } else {
      report.unchanged.push(result.indexPath);
    }
    report.flaggedRenames.push(...result.renames);
    report.overTagDropped.push(...result.overTagDropped);
  }

  // Clear dirty marker on success.
  if (!dryRun) {
    const markerPath = join(rootPath, '.index-dirty');
    if (recovery) {
      report.dirtyClear = await mutateRecoveryMarker(conceptionPath, markerPath, null, recovery);
    } else {
      try {
        await fs.unlink(markerPath);
        report.dirtyClear = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Per-directory pass.
// ---------------------------------------------------------------------------

interface DirResult {
  indexPath: string;
  created: boolean;
  changed: boolean;
  added: string[];
  dropped: string[];
  tagsAdded: { entry: string; tags: string[] }[];
  renames: RenameFlag[];
  overTagDropped: { indexPath: string; entry: string; dropped: string[] }[];
}

async function processDirectory(
  dirAbsPath: string,
  conceptionPath: string,
  strategy: IndexStrategy,
  aggregatedKeywords: Map<string, Map<string, number>>,
  dryRun: boolean,
  rewriteAggregated: boolean,
  confirmedRenames?: ReadonlySet<string>,
  recovery?: IndexRecoveryLifecycle,
): Promise<DirResult> {
  const indexPath = join(dirAbsPath, 'index.md');
  const indexRel = relative(conceptionPath, indexPath);

  const result: DirResult = {
    indexPath: indexRel,
    created: false,
    changed: false,
    added: [],
    dropped: [],
    tagsAdded: [],
    renames: [],
    overTagDropped: [],
  };

  // Enumerate immediate children, classified.
  const children = await listChildren(dirAbsPath, strategy, recovery);

  // Read or template the existing index.md.
  let existingRaw: string | null;
  let renderState: RecoveryFileState | undefined;
  if (recovery) {
    await recovery.validateInput({ path: resolve(indexPath), kind: 'output' });
    renderState = await readRecoveryFileState(conceptionPath, indexPath);
    existingRaw = renderState.bytes?.toString('utf8') ?? null;
  } else {
    try {
      existingRaw = await fs.readFile(indexPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') existingRaw = null;
      else throw err;
    }
  }

  const isNew = existingRaw === null;
  const baseRaw =
    existingRaw ?? strategy.initialTemplate(relative(conceptionPath, dirAbsPath) || '.');
  const shape = parseIndex(baseRaw);

  // Detect renames: bullets whose target is gone but a similar new on-disk
  // child appeared. Surface these to the user; the engine never silently
  // rewrites — too easy to invent a bad rename.
  const onDiskNames = new Set(children.map((c) => canonicalName(c)));
  const newCanonicalNames = children
    .map((c) => canonicalName(c))
    .filter((n) => !shape.bullets.has(n));
  const droppedBullets: { canonical: string; bullet: BulletEntry }[] = [];
  for (const [canonical, bullet] of shape.bullets) {
    if (!onDiskNames.has(canonical)) {
      // Loose-row ownership amendment (user-approved 2026-11-18): a
      // NON-draft loose row whose target is not a real child is human-owned
      // prose — preserved verbatim like the hand-written cross-reference
      // rule, never dropped, never re-rendered, never re-keyed. A draft
      // loose row is the engine's own stale output and still drops.
      if (!bullet.draft && bullet.loose) continue;
      droppedBullets.push({ canonical, bullet });
    }
  }
  for (const { canonical, bullet } of droppedBullets) {
    const candidate = newCanonicalNames.find((n) => similarityOk(bullet.name, n));
    if (candidate) {
      result.renames.push({
        indexPath: indexRel,
        oldName: bullet.name,
        newName: candidate,
      });
    } else {
      result.dropped.push(bullet.name);
    }
    // Delete by the map's own key (canonical `subdir/` form) — the raw bullet
    // name may lack the trailing slash, and a miss here meant the stale
    // bullet survived the render and got re-reported on every run.
    shape.bullets.delete(canonical);
  }

  // Draft new entries for on-disk children that have no bullet yet. New
  // entries are always emitted with the `<!-- draft -->` marker so the human
  // can spot them and curate before they ossify into "permanent" bullets.
  const newEntries: BulletEntry[] = [];
  for (const child of children) {
    const canonical = canonicalName(child);
    if (shape.bullets.has(canonical)) continue;
    // A suspected rename's new name is skipped so the human decides — unless
    // the caller confirmed the rename (`projects rename`), in which case the
    // bullet is drafted right away from the moved item's own content.
    if (
      result.renames.some((r) => r.newName === canonical) &&
      !hasConfirmedRename(confirmedRenames, canonical)
    ) {
      continue;
    }

    let draft: DraftResult;
    await validateDraftInput(dirAbsPath, child, strategy, recovery);
    if (child.kind === 'file') {
      draft = await strategy.draftFileEntry(dirAbsPath, child);
    } else {
      const ranked = rankAggregatedTags(aggregatedKeywords.get(child.absPath) ?? new Map());
      draft = await strategy.draftSubdirEntry(dirAbsPath, child, ranked.kept);
      if (ranked.dropped.length > 0) {
        result.overTagDropped.push({
          indexPath: indexRel,
          entry: canonical,
          dropped: ranked.dropped,
        });
      }
    }

    const sectionHeading = pickBucketHeading(shape, child);
    const link = strategy.formatChildLink(dirAbsPath, child);
    const linkName = child.kind === 'directory' ? `${child.name}/` : child.name;
    const bullet = formatBullet(linkName, link, draft, /* isDraft */ true);
    newEntries.push({
      name: canonical,
      raw: bullet,
      tags: draft.keywords,
      sectionHeading,
      draft: true,
      loose: false,
    });
    result.added.push(canonical);
  }

  // For *existing* subdir bullets, re-derive tags from the descendant
  // aggregate when (a) the bullet is drafted (engine-owned), or (b) we're in
  // --rewrite-aggregated migration mode. Curated bullets are left alone.
  // Run this BEFORE building `myAggregate` below so the rolled-up counts
  // reflect the corrected tags — otherwise a parent pass picks up stale
  // tag values from before this loop's mutations and convergence takes an
  // extra pass.
  for (const child of children) {
    if (child.kind !== 'directory') continue;
    const canonical = canonicalName(child);
    const bullet = shape.bullets.get(canonical);
    if (!bullet) continue;
    // A loose-matched bullet is always engine-rewritten, regardless of the
    // draft marker — the line is malformed and must be repaired.
    const isEngineOwned = bullet.draft || rewriteAggregated || bullet.loose;
    if (!isEngineOwned) continue;

    const childFreq = aggregatedKeywords.get(child.absPath) ?? new Map();
    const ranked = rankAggregatedTags(childFreq);
    // Leaf-like children (project item folders — no `index.md`, no recursion)
    // never populate the descendant aggregate. Re-route their tag derivation
    // through `draftSubdirEntry`, which the strategy implements by reading
    // the README. Container children (months, knowledge subdirs) keep using
    // the aggregate — `draftSubdirEntry` for those just hands `aggregated.kept`
    // back as `keywords`, so the call is shape-preserving.
    await validateDraftInput(dirAbsPath, child, strategy, recovery);
    const draft = await strategy.draftSubdirEntry(dirAbsPath, child, ranked.kept);
    const newTags = draft.keywords;

    // Compute the diff for the change report.
    const additions = newTags.filter((t) => !bullet.tags.includes(t));
    const removals = bullet.tags.filter((t) => !newTags.includes(t));

    // Promote a curated-but-rewritten bullet to drafted: --rewrite-aggregated
    // is the explicit "I want the engine to own this from now on" signal.
    const becameDraft = !bullet.draft;
    const willBeDraft = bullet.draft || rewriteAggregated || bullet.loose;
    // Malformed (loose-matched) bullets get rebuilt from scratch — the
    // original description is unrecoverable because the buggy
    // replaceTagsInBullet truncated it on a prior run. A full re-render
    // restores the canonical shape so the engine matches it next time.
    let newRaw: string;
    if (bullet.loose) {
      const link = strategy.formatChildLink(dirAbsPath, child);
      const linkName = `${child.name}/`;
      newRaw = formatBullet(linkName, link, draft, willBeDraft);
    } else {
      newRaw = replaceTagsInBullet(bullet.raw, newTags, willBeDraft);
    }

    if (newRaw !== bullet.raw) {
      bullet.tags = newTags;
      bullet.raw = newRaw;
      bullet.draft = willBeDraft;
      const wasLoose = bullet.loose;
      bullet.loose = false;
      if (additions.length > 0 || removals.length > 0 || becameDraft || wasLoose) {
        result.tagsAdded.push({ entry: canonical, tags: additions });
      }
    }
    if (ranked.dropped.length > 0) {
      result.overTagDropped.push({
        indexPath: indexRel,
        entry: canonical,
        dropped: ranked.dropped,
      });
    }
  }

  // Existing drafted *file* bullets are re-derived the same way — a file row
  // drafted once was previously never revisited, so junk that entered it
  // (a heading renamed since draft, old-algorithm output, a source typo)
  // ossified until a human re-drafted by hand. Files get a FULL re-render
  // (under the draft marker both description and tags are engine-owned),
  // mirroring the loose-bullet repair path above. `--rewrite-aggregated`
  // stays subdir-only: curated file bullets, marker absent, are untouched.
  // Must run before the `myAggregate` build below so corrected file tags
  // roll upward on the same pass.
  for (const child of children) {
    if (child.kind !== 'file') continue;
    const canonical = canonicalName(child);
    const bullet = shape.bullets.get(canonical);
    if (!bullet) continue;
    const isEngineOwned = bullet.draft || bullet.loose;
    if (!isEngineOwned) continue;

    await validateDraftInput(dirAbsPath, child, strategy, recovery);
    const draft = await strategy.draftFileEntry(dirAbsPath, child);
    const newTags = draft.keywords;
    const additions = newTags.filter((t) => !bullet.tags.includes(t));

    const link = strategy.formatChildLink(dirAbsPath, child);
    const willBeDraft = bullet.draft || bullet.loose;
    // Full re-render emits `body + tag block + marker` only: the marker
    // flags the row as auto-managed, so the engine owns the whole line and
    // any stray trailing comment on it is dropped (curated rows are the
    // home for human annotations, and they never reach this loop).
    const newRaw = formatBullet(child.name, link, draft, willBeDraft);

    if (newRaw !== bullet.raw) {
      bullet.tags = newTags;
      bullet.raw = newRaw;
      bullet.draft = willBeDraft;
      bullet.loose = false;
      // Full re-render: any drift from the fresh draft — a tag change or a
      // description-only change — must reach disk, so record unconditionally
      // (the loose path above records `tags: []` for a shape-only repair).
      result.tagsAdded.push({ entry: canonical, tags: additions });
    }
  }

  // Aggregate this directory's keyword footprint upward — frequency-counted
  // so the parent pass can rank candidates when the cap forces drops. Tags
  // from kept (curated *and* drafted) bullets here count as 1 each; descendant
  // contributions add their own counts. Built AFTER the per-child re-derive
  // above so the parent sees the post-mutation tag set.
  const myAggregate = new Map<string, number>();
  const bumpTag = (tag: string, by = 1): void => {
    myAggregate.set(tag, (myAggregate.get(tag) ?? 0) + by);
  };
  for (const bullet of shape.bullets.values()) {
    for (const t of bullet.tags) bumpTag(t);
  }
  for (const bullet of newEntries) {
    for (const t of bullet.tags) bumpTag(t);
  }
  // Also fold descendants (already populated since we go deepest-first).
  // Compare on POSIX-normalised views — the map keys carry the native
  // separator, and a `\`-separated key never matches a `+ '/'` prefix.
  const dirPrefix = toPosix(dirAbsPath) + '/';
  for (const [path, freq] of aggregatedKeywords) {
    if (toPosix(path).startsWith(dirPrefix)) {
      for (const [t, n] of freq) bumpTag(t, n);
    }
  }
  aggregatedKeywords.set(dirAbsPath, myAggregate);

  // Render the new file content if anything changed. `hadDuplicates`
  // forces a render even when tags/folders are unchanged, so legacy
  // duplicate bullet lines get physically removed from disk.
  const changed =
    isNew ||
    result.added.length > 0 ||
    result.dropped.length > 0 ||
    result.tagsAdded.length > 0 ||
    shape.hadDuplicates;

  if (recovery) {
    const proposed = changed ? Buffer.from(renderIndex(shape, newEntries)) : renderState!.bytes!;
    await withFileQueue(indexPath, async () => {
      const current = await readRecoveryFileState(conceptionPath, indexPath);
      assertRecoveryFileUnchanged(indexPath, renderState!, current);
      await recovery.applyOutput({
        path: resolve(indexPath),
        input: renderState!.bytes === null ? null : Buffer.from(renderState!.bytes),
        proposed: Buffer.from(proposed),
        changed,
        renames: result.renames,
      });
    });
  } else if (changed) {
    const rendered = renderIndex(shape, newEntries);
    if (!dryRun) {
      // The GUI's mutation writers queue per path through `withFileQueue`;
      // the regen must join the same queue so a concurrent in-app edit of
      // the index never interleaves (internals invariant 2).
      await withFileQueue(indexPath, () => atomicWrite(indexPath, rendered));
    }
  }

  result.created = isNew;
  result.changed = !isNew && changed;
  return result;
}

// ---------------------------------------------------------------------------
// Bucket-heading selection: where does a new bullet land?
// ---------------------------------------------------------------------------
function pickBucketHeading(shape: IndexFileShape, child: ChildInfo): string {
  const wantKind: 'file' | 'dir' = child.kind === 'directory' ? 'dir' : 'file';
  // Prefer a section already populated with the right kind.
  for (const section of shape.sections) {
    if (section.kind === wantKind) return section.heading;
  }
  // Then any "mixed" section.
  for (const section of shape.sections) {
    if (section.kind === 'mixed') return section.heading;
  }
  // Fall through: synthesise a heading. The renderer creates the section if
  // it doesn't exist already.
  if (wantKind === 'dir') {
    // Knowledge root uses "Structure"; projects root uses "Months"; subdirs
    // use "Subcategories". The renderer also handles "Current files" for a
    // file-only subdir. Default to "Structure" for dirs as the generic case.
    return shape.sections.find((s) => s.heading === 'Structure')
      ? 'Structure'
      : shape.sections.find((s) => s.heading === 'Subcategories')
        ? 'Subcategories'
        : shape.sections.find((s) => s.heading === 'Months')
          ? 'Months'
          : shape.sections.find((s) => s.heading === 'Items')
            ? 'Items'
            : 'Structure';
  }
  return shape.sections.find((s) => s.heading === 'Current files')
    ? 'Current files'
    : shape.sections.find((s) => s.heading === 'Root body files')
      ? 'Root body files'
      : 'Current files';
}

// ---------------------------------------------------------------------------
// Index file parser + renderer.
// ---------------------------------------------------------------------------

function parseIndex(raw: string): IndexFileShape {
  const lines = raw.split(/\r?\n/);
  const eol = detectEol(raw);
  const sections: SectionRange[] = [];
  const bullets = new Map<string, BulletEntry>();
  let hadDuplicates = false;

  // Fenced code blocks are prose, not structure: a ```/~~~ block in
  // hand-written index prose must not contribute headings or engine-owned
  // bullets. Same fence tracking as every other reader.
  const unfenced = new Set(Array.from(iterUnfencedLines(lines), ({ index }) => index));

  // Walk the file collecting heading offsets.
  const headingPositions: { line: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!unfenced.has(i)) continue;
    const m = lines[i].match(HEADING2_RE);
    if (m) headingPositions.push({ line: i, heading: m[1].trim() });
  }

  // Build sections. Prologue (everything above the first heading) gets
  // an implicit empty-heading section so we can preserve it.
  if (headingPositions.length === 0) {
    sections.push({
      heading: '',
      headingLine: -1,
      contentStart: 0,
      contentEnd: lines.length,
      kind: 'empty',
    });
  } else {
    sections.push({
      heading: '',
      headingLine: -1,
      contentStart: 0,
      contentEnd: headingPositions[0].line,
      kind: 'empty',
    });
    for (let i = 0; i < headingPositions.length; i++) {
      const next = headingPositions[i + 1]?.line ?? lines.length;
      sections.push({
        heading: headingPositions[i].heading,
        headingLine: headingPositions[i].line,
        contentStart: headingPositions[i].line + 1,
        contentEnd: next,
        kind: 'empty',
      });
    }
  }

  // Walk each section's content for bullets, classifying section kind.
  for (const section of sections) {
    let dirCount = 0;
    let fileCount = 0;
    for (let i = section.contentStart; i < section.contentEnd; i++) {
      if (!unfenced.has(i)) continue;
      const line = lines[i];
      const m = matchBullet(line);
      if (!m) continue;
      const rawName = m.name.trim();
      const link = m.link.trim();
      // Hand-written cross-reference bullet (external URL, deeper path, …):
      // not engine-owned — leave it out of the bullets map so the renderer
      // passes the line through verbatim and never drops it as "stale".
      if (!m.draft && !isImmediateChildLink(link)) continue;
      const isDir = rawName.endsWith('/') || link.endsWith('/index.md');
      if (isDir) dirCount++;
      else fileCount++;
      const tags = parseTagList(m.tags);
      const canonical = canonicalNameFromBullet(rawName, link);
      // De-duplication: keep the first strict bullet for a given canonical,
      // and only fall back to a loose-matched line if no strict bullet was
      // seen for the same folder. Loose entries flag the bullet for full
      // re-rendering in processDirectory.
      const existing = bullets.get(canonical);
      if (existing && !existing.loose) {
        hadDuplicates = true;
        continue;
      }
      if (existing && existing.loose && m.loose) {
        hadDuplicates = true;
        continue;
      }
      bullets.set(canonical, {
        name: rawName,
        raw: line,
        tags,
        sectionHeading: section.heading,
        draft: m.draft,
        loose: m.loose,
      });
    }
    if (dirCount === 0 && fileCount === 0) section.kind = 'empty';
    else if (dirCount > 0 && fileCount === 0) section.kind = 'dir';
    else if (fileCount > 0 && dirCount === 0) section.kind = 'file';
    else section.kind = 'mixed';
  }

  return { lines, eol, sections, bullets, hadDuplicates, unfenced };
}

/**
 * Re-render the index. Per-section logic:
 *  - Prologue (empty heading): preserved verbatim.
 *  - Section that already had bullets we kept: rewrite the bullet list inline,
 *    preserving non-bullet content (intro paragraphs, sub-list items not
 *    matching the bullet regex).
 *  - Section that gains a new bullet: append the new bullet at the end of the
 *    section's bullet block.
 *  - Brand-new bullet whose target heading doesn't exist yet: append a new
 *    `## <Heading>` section at the bottom.
 */
function renderIndex(shape: IndexFileShape, newEntries: BulletEntry[]): string {
  const lines = [...shape.lines];

  // Group new entries by target heading.
  const newBySection = new Map<string, BulletEntry[]>();
  for (const entry of newEntries) {
    const list = newBySection.get(entry.sectionHeading) ?? [];
    list.push(entry);
    newBySection.set(entry.sectionHeading, list);
  }

  // Build a "kept bullets" set so we know which existing bullet lines should
  // remain. (Dropped bullets are not in shape.bullets after the diff pass.)
  const keptCanonical = new Set<string>(shape.bullets.keys());

  // Process sections from bottom up so line-index splices don't invalidate
  // earlier offsets.
  const sectionsBottomUp = [...shape.sections].reverse();
  for (const section of sectionsBottomUp) {
    // The prologue (headingLine === -1, everything above the first `##`) is
    // managed too: some hand-authored indexes list their body-file bullets
    // directly under the H1 with no `## Current files` heading. `pickBucketHeading`
    // returns '' for those, so a new bullet's only home is the prologue. The
    // bullet-block scan below preserves the intro prose and only rewrites the
    // contiguous bullet lines, so running it on the prologue is safe even when
    // the prologue is pure prose (no bullets, no additions → no-op).

    // Find the contiguous bullet-block within this section.
    let bulletStart = -1;
    let bulletEnd = -1;
    for (let i = section.contentStart; i < section.contentEnd; i++) {
      // Fenced code blocks are prose, not structure — the same invariant
      // parseIndex applies when collecting bullets. A fence line or a line
      // inside a fence must never start or extend the bullet block, and a
      // fence line ends an open block like any other non-bullet prose, so
      // fenced content always survives the render verbatim.
      if (!shape.unfenced.has(i)) {
        if (bulletStart !== -1) break;
        continue;
      }
      if (matchBullet(lines[i])) {
        if (bulletStart === -1) bulletStart = i;
        bulletEnd = i + 1;
      } else if (bulletStart !== -1 && lines[i].trim() !== '') {
        // First non-empty non-bullet after the bullet block ends the block.
        break;
      }
    }

    // Filter existing bullet lines: keep only those whose canonical name is
    // still in shape.bullets, and replace the line with the (possibly tag-
    // augmented) raw form. De-duplicate by canonical so that legacy
    // duplicate bullets (e.g. the old bracket-in-description corruption)
    // collapse to a single entry on the next regen.
    if (bulletStart !== -1) {
      const newBulletLines: string[] = [];
      const seen = new Set<string>();
      for (let i = bulletStart; i < bulletEnd; i++) {
        const m = matchBullet(lines[i]);
        if (!m) {
          newBulletLines.push(lines[i]);
          continue;
        }
        // Hand-written cross-reference bullet — not engine-owned, preserved
        // verbatim like prose (mirrors the parseIndex ownership gate).
        if (!m.draft && !isImmediateChildLink(m.link.trim())) {
          newBulletLines.push(lines[i]);
          continue;
        }
        const canonical = canonicalNameFromBullet(m.name.trim(), m.link.trim());
        const bullet = shape.bullets.get(canonical);
        if (!bullet) continue; // dropped
        if (!keptCanonical.has(canonical)) continue;
        if (seen.has(canonical)) continue; // duplicate of an earlier bullet
        seen.add(canonical);
        newBulletLines.push(bullet.raw);
      }
      const additions = newBySection.get(section.heading) ?? [];
      for (const a of additions) newBulletLines.push(a.raw);
      lines.splice(bulletStart, bulletEnd - bulletStart, ...newBulletLines);
    } else {
      // No existing bullets — if we have new ones for this section, append
      // them at the section content end.
      const additions = newBySection.get(section.heading) ?? [];
      if (additions.length > 0) {
        const insertion = additions.map((a) => a.raw);
        let insertAt = section.contentEnd;
        // Trim trailing blank lines so the new block sits flush.
        while (insertAt - 1 > section.contentStart && lines[insertAt - 1].trim() === '') {
          insertAt--;
        }
        // Drop a blank line of breathing room if needed.
        const breathing = insertAt > 0 && lines[insertAt - 1].trim() !== '' ? [''] : [];
        lines.splice(insertAt, 0, ...breathing, ...insertion);
      }
    }

    newBySection.delete(section.heading);
  }

  // Any new entries pointing at sections that don't exist yet get appended
  // as fresh `## <Heading>` blocks.
  for (const [heading, entries] of newBySection) {
    if (heading === '') continue; // shouldn't happen — prologue isn't a target
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${heading}`, '', ...entries.map((e) => e.raw));
  }

  // Ensure exactly one trailing newline, in the source file's own EOL so a
  // CRLF-authored index doesn't get a whole-file line-ending flip.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join(shape.eol) + shape.eol;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'local', 'notes']);

export interface IndexDirectoryEntry {
  name: string;
  kind: 'directory' | 'file' | 'other';
}

/** Metadata-only H/M directory lookup for the conservative envelope, never a render/source overlay. */
export type IndexDirectoryReader = (path: string) => Promise<readonly IndexDirectoryEntry[] | null>;

/** Enumerate actual outputs and potential direct reads using the generator's own walkers. */
export async function enumerateIndexPaths(
  conceptionPath: string,
  strategy: IndexStrategy,
  recovery?: IndexRecoveryLifecycle,
  prospectiveDirectory?: IndexDirectoryReader,
): Promise<IndexPathEnumeration> {
  const rootPath = join(conceptionPath, strategy.rootDirName);
  await recovery?.validateInput({ path: resolve(rootPath), kind: 'directory' });
  try {
    if (prospectiveDirectory) {
      if ((await indexDirectoryEntries(rootPath, prospectiveDirectory)) === null)
        return { outputs: [], inputs: [] };
    } else await fs.access(rootPath);
  } catch (error) {
    if (prospectiveDirectory || (recovery && (error as NodeJS.ErrnoException).code !== 'ENOENT'))
      throw error;
    return { outputs: [], inputs: [] };
  }
  const directories = await listAllDirectories(rootPath, recovery, prospectiveDirectory);
  const inputs = new Set<string>();
  for (const directory of directories) {
    for (const child of await listChildren(directory, strategy, recovery, prospectiveDirectory)) {
      const input = draftInput(directory, child, strategy);
      if (input) {
        await recovery?.validateInput(input);
        inputs.add(toPosix(relative(conceptionPath, input.path)));
      }
    }
  }
  if (strategy.preValidation) {
    for (const path of await projectValidationInputs(
      conceptionPath,
      recovery,
      prospectiveDirectory,
    )) {
      await recovery?.validateInput({ path, kind: 'readme' });
      inputs.add(toPosix(relative(conceptionPath, path)));
    }
  }
  return {
    outputs: directories.map((directory) =>
      toPosix(relative(conceptionPath, join(directory, 'index.md'))),
    ),
    inputs: [...inputs].sort(),
  };
}

/** Retain a recovery tree's marker through the same queued lifecycle as marker clearing. */
export async function retainRecoveryIndexDirtyMarker(
  conceptionPath: string,
  tree: 'projects' | 'knowledge',
  recovery: IndexRecoveryLifecycle,
): Promise<void> {
  await mutateRecoveryMarker(
    conceptionPath,
    join(conceptionPath, tree, '.index-dirty'),
    true,
    recovery,
  );
}

async function mutateRecoveryMarker(
  conceptionPath: string,
  markerPath: string,
  retain: true | null,
  recovery: IndexRecoveryLifecycle,
): Promise<boolean> {
  return withFileQueue(markerPath, async () => {
    await recovery.validateInput({ path: resolve(markerPath), kind: 'marker' });
    const state = await readRecoveryFileState(conceptionPath, markerPath);
    const current = await readRecoveryFileState(conceptionPath, markerPath);
    assertRecoveryFileUnchanged(markerPath, state, current);
    await recovery.applyMarker({
      path: resolve(markerPath),
      input: state.bytes === null ? null : Buffer.from(state.bytes),
      proposed: retain ? Buffer.from(state.bytes ?? '') : null,
    });
    return state.bytes !== null;
  });
}

function draftInput(
  parent: string,
  child: ChildInfo,
  strategy: IndexStrategy,
): IndexRecoveryInput | null {
  if (strategy.treeName === 'knowledge') {
    return {
      path: resolve(child.kind === 'file' ? child.absPath : join(child.absPath, 'index.md')),
      kind: 'source',
    };
  }
  if (child.kind === 'directory') {
    if (/^\d{4}-\d{2}$/.test(basename(parent)) && /^\d{4}-\d{2}-\d{2}-/.test(child.name)) {
      return { path: resolve(child.absPath, 'README.md'), kind: 'readme' };
    }
    if (basename(parent) === 'projects' && /^\d{4}-\d{2}$/.test(child.name)) {
      return { path: resolve(child.absPath, 'index.md'), kind: 'source' };
    }
  }
  return null;
}

async function validateDraftInput(
  parent: string,
  child: ChildInfo,
  strategy: IndexStrategy,
  recovery?: IndexRecoveryLifecycle,
): Promise<void> {
  if (!recovery) return;
  const input = draftInput(parent, child, strategy);
  if (input) await recovery.validateInput(input);
}

async function projectValidationInputs(
  conceptionPath: string,
  recovery?: IndexRecoveryLifecycle,
  prospectiveDirectory?: IndexDirectoryReader,
): Promise<string[]> {
  const root = join(conceptionPath, 'projects');
  const inputs: string[] = [];
  for (const month of await subdirectories(root)) {
    for (const item of await subdirectories(join(root, month))) {
      inputs.push(resolve(root, month, item, 'README.md'));
    }
  }
  return inputs;

  async function subdirectories(path: string): Promise<string[]> {
    await recovery?.validateInput({ path: resolve(path), kind: 'directory' });
    try {
      const directories: string[] = [];
      for await (const entry of await iterateIndexDirectory(path, prospectiveDirectory, recovery)) {
        if (entry.kind !== 'directory' || entry.name.startsWith('.')) continue;
        await recovery?.validateInput({ path: resolve(path, entry.name), kind: 'directory' });
        directories.push(entry.name);
      }
      return directories.sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

interface RecoveryFileState {
  bytes: Buffer | null;
  identity: string | null;
  ancestors: string[];
}

function fileIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

async function readRecoveryFileState(
  conceptionPath: string,
  path: string,
): Promise<RecoveryFileState> {
  const root = resolve(conceptionPath);
  const target = resolve(path);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
    throw new Error(`Recovery path is outside conception: ${JSON.stringify(path)}`);
  }
  if ((await fs.realpath(root)) !== root)
    throw new Error('Recovery conception has symlink ancestors');
  const ancestors: string[] = [];
  let directory = root;
  for (const component of ['', ...relative(root, dirname(target)).split(sep).filter(Boolean)]) {
    if (component) directory = join(directory, component);
    const stat = await fs.lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe recovery ancestor: ${JSON.stringify(directory)}`);
    }
    ancestors.push([stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':'));
  }
  const stat = await fs.lstat(target, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { bytes: null, identity: null, ancestors };
  if (!stat.isFile() || stat.nlink !== 1n) {
    throw new Error(`Unsafe recovery file: ${JSON.stringify(target)}`);
  }
  if (stat.size > 8n * 1024n * 1024n)
    throw new Error('Recovery output exceeds the 8 MiB supported bound');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = fileIdentity(stat);
    if (fileIdentity(await handle.stat({ bigint: true })) !== identity) {
      throw new Error(`Recovery file changed before read: ${JSON.stringify(target)}`);
    }
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (
      size !== Number(stat.size) ||
      fileIdentity(await handle.stat({ bigint: true })) !== identity ||
      fileIdentity(await fs.lstat(target, { bigint: true })) !== identity
    ) {
      throw new Error(`Recovery file changed during read: ${JSON.stringify(target)}`);
    }
    return { bytes: buffer.subarray(0, size), identity, ancestors };
  } finally {
    await handle.close();
  }
}

function assertRecoveryFileUnchanged(
  path: string,
  before: RecoveryFileState,
  current: RecoveryFileState,
): void {
  if (
    before.identity !== current.identity ||
    before.ancestors.join('/') !== current.ancestors.join('/') ||
    (before.bytes === null
      ? current.bytes !== null
      : !before.bytes.equals(current.bytes ?? Buffer.alloc(0)))
  ) {
    throw new Error(`Recovery render input changed: ${JSON.stringify(path)}`);
  }
}

async function listAllDirectories(
  rootPath: string,
  recovery?: IndexRecoveryLifecycle,
  prospectiveDirectory?: IndexDirectoryReader,
): Promise<string[]> {
  const out: string[] = [rootPath];
  await walk(rootPath);
  return out;

  async function walk(dir: string): Promise<void> {
    await recovery?.validateInput({ path: resolve(dir), kind: 'directory' });
    let entries: AsyncIterable<IndexDirectoryEntry>;
    try {
      entries = await iterateIndexDirectory(dir, prospectiveDirectory, recovery);
    } catch (error) {
      if (recovery || prospectiveDirectory) throw error;
      return;
    }
    for await (const entry of entries) {
      if (entry.kind !== 'directory') continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // Project item dirs (`YYYY-MM-DD-slug/`) carry a README.md, not an
      // index.md — they are *children* listed in the month index but not
      // directories the engine writes into. Skip both the push and the
      // recursion. `notes/` lives below them and is in SKIP_DIR_NAMES already.
      if (/^\d{4}-\d{2}-\d{2}-/.test(entry.name)) continue;
      const full = join(dir, entry.name);
      await recovery?.validateInput({ path: resolve(full), kind: 'directory' });
      out.push(full);
      await walk(full);
    }
  }
}

async function listChildren(
  dirAbsPath: string,
  strategy: IndexStrategy,
  recovery?: IndexRecoveryLifecycle,
  prospectiveDirectory?: IndexDirectoryReader,
): Promise<ChildInfo[]> {
  const out: ChildInfo[] = [];
  await recovery?.validateInput({ path: resolve(dirAbsPath), kind: 'directory' });
  let entries: AsyncIterable<IndexDirectoryEntry>;
  try {
    entries = await iterateIndexDirectory(dirAbsPath, prospectiveDirectory, recovery);
  } catch (error) {
    if (recovery || prospectiveDirectory) throw error;
    return out;
  }
  const isMonthDir = strategy.treeName === 'projects' && /^\d{4}-\d{2}$/.test(basename(dirAbsPath));
  const isProjectsRoot = strategy.treeName === 'projects' && basename(dirAbsPath) === 'projects';
  for await (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'index.md') continue;
    const full = join(dirAbsPath, entry.name);
    if (entry.kind === 'directory') {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // For projects root: only month dirs are children. For month dirs:
      // only item dirs are children. For knowledge: everything is.
      if (isProjectsRoot && !/^\d{4}-\d{2}$/.test(entry.name)) continue;
      const child: ChildInfo = { kind: 'directory', name: entry.name, absPath: full };
      await validateDraftInput(dirAbsPath, child, strategy, recovery);
      out.push(child);
    } else if (entry.kind === 'file') {
      // Project month dirs and project item dirs have no body files at the
      // index level. Knowledge does.
      if (strategy.treeName === 'projects' && (isMonthDir || isProjectsRoot)) continue;
      if (entry.name.toLowerCase().endsWith('.md')) {
        await recovery?.validateInput({ path: resolve(full), kind: 'source' });
        out.push({ kind: 'file', name: entry.name, absPath: full });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function iterateIndexDirectory(
  path: string,
  prospectiveDirectory?: IndexDirectoryReader,
  recovery?: IndexRecoveryLifecycle,
): Promise<AsyncIterable<IndexDirectoryEntry>> {
  if (recovery && !prospectiveDirectory) {
    const directory = await fs.opendir(path);
    return (async function* () {
      for await (const entry of directory)
        yield {
          name: entry.name,
          kind: entry.isDirectory()
            ? ('directory' as const)
            : entry.isFile()
              ? ('file' as const)
              : ('other' as const),
        };
    })();
  }
  const entries = await indexDirectoryEntries(path, prospectiveDirectory);
  if (entries === null)
    throw Object.assign(new Error('Recovery directory vanished'), { code: 'ENOENT' });
  return (async function* () {
    yield* entries;
  })();
}

async function indexDirectoryEntries(
  path: string,
  prospectiveDirectory?: IndexDirectoryReader,
): Promise<readonly IndexDirectoryEntry[] | null> {
  if (prospectiveDirectory) {
    const entries = await prospectiveDirectory(resolve(path));
    if (entries)
      for (const entry of entries) {
        if (
          !entry.name ||
          entry.name === '.' ||
          entry.name === '..' ||
          /[\/\0]/.test(entry.name) ||
          !['directory', 'file', 'other'].includes(entry.kind)
        )
          throw new Error('Invalid prospective index directory metadata');
      }
    return entries;
  }
  return (await fs.readdir(path, { withFileTypes: true })).map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
  }));
}

function canonicalName(child: ChildInfo): string {
  return child.kind === 'directory' ? `${child.name}/` : child.name;
}

/** Canonical names carry a trailing slash for directories; callers holding
 *  the bare folder name (the rename verb) match either spelling. */
function hasConfirmedRename(set: ReadonlySet<string> | undefined, canonical: string): boolean {
  if (!set || set.size === 0) return false;
  return set.has(canonical) || set.has(canonical.replace(/\/$/, ''));
}

function canonicalNameFromBullet(name: string, link: string): string {
  // Bullets sometimes spell the dir as `subdir/` and sometimes as `subdir`.
  // Use the link to disambiguate.
  if (link.endsWith('/index.md') || link.endsWith('/')) {
    const base = name.replace(/\/?$/, '');
    return `${base}/`;
  }
  // Project item entries: link looks like `2026-04-XX-foo/README.md`. Treat
  // them as directories.
  if (link.endsWith('/README.md')) {
    const base = name.replace(/\/?$/, '');
    return `${base}/`;
  }
  return name;
}

function similarityOk(a: string, b: string): boolean {
  // Cheap: shared prefix of length ≥ 5, or shared suffix of length ≥ 5.
  // Good enough to flag a likely rename without false positives.
  const aL = a.toLowerCase();
  const bL = b.toLowerCase();
  let prefix = 0;
  while (prefix < Math.min(aL.length, bL.length) && aL[prefix] === bL[prefix]) prefix++;
  if (prefix >= 5) return true;
  let suffix = 0;
  while (
    suffix < Math.min(aL.length, bL.length) &&
    aL[aL.length - 1 - suffix] === bL[bL.length - 1 - suffix]
  ) {
    suffix++;
  }
  return suffix >= 5;
}

function parseTagList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

/**
 * Rank aggregated tag candidates from a frequency map. Drops low-quality
 * entries (stop-words, dates, UUIDs, etc.), then sorts by descending frequency
 * with a name tiebreaker for stable output, then caps at `TARGET_MAX`. Returns
 * the kept set plus any candidates that couldn't fit the cap (so the CLI can
 * surface them via `overTagDropped`).
 */
function rankAggregatedTags(freq: Map<string, number>): { kept: string[]; dropped: string[] } {
  const candidates: { tag: string; count: number }[] = [];
  for (const [tag, count] of freq) {
    if (isLowQualityTag(tag)) continue;
    candidates.push({ tag, count });
  }
  candidates.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  const kept = candidates.slice(0, TARGET_MAX).map((c) => c.tag);
  const dropped = candidates.slice(TARGET_MAX).map((c) => c.tag);
  return { kept, dropped };
}

function formatBullet(
  linkName: string,
  link: string,
  draft: DraftResult,
  isDraft: boolean,
): string {
  const desc = draft.description.replace(/\.$/, '');
  const tags = draft.keywords.length > 0 ? ` \`[${draft.keywords.join(', ')}]\`` : '';
  const marker = isDraft ? ` ${DRAFT_MARKER}` : '';
  return `- [\`${linkName}\`](${link}) — *${desc}.*${tags}${marker}`;
}

// Trailing tag block: ` `[t1, t2, …]` `. **Backticks are required**, both
// to distinguish a real tag block from a bracketed substring living inside
// the description (e.g. a clipped `["#<name>"]` array — see #NNN) and to
// keep the format strict. An earlier optional-backtick form would scan
// left-to-right and match the *first* bracketed segment near end-of-line,
// which on a description ending with a clipped `[` ate the closing italic
// and the genuine tag block in one go — leaving the bullet malformed and
// invisible to the next-run matcher.
const TAG_BLOCK_RE = /\s*`\[[^\]]*\]`\s*$/;

function replaceTagsInBullet(raw: string, tags: string[], isDraft: boolean): string {
  // Remove the end-anchored draft marker, then drop any other trailing
  // comments one at a time from the line end (tempered, so only true
  // trailing comments are touched). The row is auto-managed, so stray
  // comments are dropped, not preserved; then the tag block is replaced.
  // Canonical output: `body + new tag block + marker`.
  let stripped = raw.replace(DRAFT_MARKER_RE, '');
  while (TRAILING_COMMENT_RE.test(stripped)) {
    stripped = stripped.replace(TRAILING_COMMENT_RE, '');
  }
  const tagBlock = tags.length > 0 ? ` \`[${tags.join(', ')}]\`` : '';
  let body: string;
  if (TAG_BLOCK_RE.test(stripped)) {
    body = stripped.replace(TAG_BLOCK_RE, '') + tagBlock;
  } else {
    body = stripped + tagBlock;
  }
  return isDraft ? `${body} ${DRAFT_MARKER}` : body;
}
