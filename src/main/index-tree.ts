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
 *    re-derived from the current source on every run, junk is filtered out,
 *    and the aggregated tag list is capped at 8 (`TARGET_MAX`). Surplus
 *    candidates are reported via `overTagDropped`.
 *  - `--rewrite-aggregated` mode (one-shot migration): treats every existing
 *    subdir bullet as drafted for the duration of the run, then re-derives
 *    its tags from current source and adds the marker. Used to clean a tree
 *    that was polluted by the legacy "set union, no drops" aggregator.
 *
 * Strategy interface plugs in the per-tree drafting heuristic (how to read a
 * new file's body and propose a description + keywords) and the optional
 * pre-pass validator (projects has one; knowledge doesn't).
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { isLowQualityTag } from './index-tag-filter';

/** Per-bullet aggregated-tag cap. Surplus is dropped and surfaced in overTagDropped. */
const TARGET_MAX = 8;

/** HTML-comment marker rendered on every engine-drafted bullet. */
const DRAFT_MARKER = '<!-- draft -->';
const DRAFT_MARKER_RE = /\s+<!--\s*draft\s*-->\s*$/;
/** Catch-all for any trailing `<!-- ... -->` HTML comment a curator might
 * have appended (e.g. `<!-- TBC -->`). Stripped before the bullet regex
 * runs so the entry still matches; preserved via `bullet.raw` on re-render. */
const TRAILING_COMMENT_RE = /\s+<!--[^]*?-->\s*$/;

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
}

interface IndexFileShape {
  /** Lines of the file split by \n, no trailing newline tracking. */
  lines: string[];
  /** Sections in order: name + the line-range they own (start = heading line, end = exclusive). */
  sections: SectionRange[];
  /** Existing bullets, keyed by name (canonical link-text form). */
  bullets: Map<string, BulletEntry>;
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
const HEADING2_RE = /^##\s+(.+?)\s*$/;

function matchBullet(
  line: string,
): { name: string; link: string; desc: string; tags: string; draft: boolean } | null {
  // Detect (and strip) a trailing `<!-- draft -->` marker before running the
  // existing bullet regexes — keeps the regexes blissfully unaware of the
  // marker. Any other trailing HTML comment (e.g. `<!-- TBC -->`) is also
  // stripped so the bullet still matches; the comment lives in `bullet.raw`
  // and survives re-render verbatim.
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
    };
  const b = stripped.match(BULLET_NO_TAGS_RE);
  if (b)
    return {
      name: (b.groups as { name: string }).name,
      link: (b.groups as { link: string }).link,
      desc: (b.groups as { desc: string }).desc,
      tags: '',
      draft,
    };
  return null;
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
  options: { dryRun?: boolean; rewriteAggregated?: boolean } = {},
): Promise<IndexRegenReport> {
  const dryRun = options.dryRun === true;
  const rewriteAggregated = options.rewriteAggregated === true;
  const rootPath = join(conceptionPath, strategy.rootDirName);

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
  } catch {
    return report;
  }

  if (strategy.preValidation) {
    report.validationWarnings = await strategy.preValidation(rootPath, conceptionPath);
  }

  // Collect every directory under root, then process leaves first so a parent
  // index can lift the just-written subdir's intro for its draft.
  const allDirs = await listAllDirectories(rootPath);
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
    try {
      await fs.unlink(markerPath);
      report.dirtyClear = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
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
  const children = await listChildren(dirAbsPath, strategy);

  // Read or template the existing index.md.
  let existingRaw: string | null;
  try {
    existingRaw = await fs.readFile(indexPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') existingRaw = null;
    else throw err;
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
  const droppedBullets: BulletEntry[] = [];
  for (const [name, bullet] of shape.bullets) {
    if (!onDiskNames.has(name)) droppedBullets.push(bullet);
  }
  for (const dropped of droppedBullets) {
    const candidate = newCanonicalNames.find((n) => similarityOk(dropped.name, n));
    if (candidate) {
      result.renames.push({
        indexPath: indexRel,
        oldName: dropped.name,
        newName: candidate,
      });
    } else {
      result.dropped.push(dropped.name);
    }
    shape.bullets.delete(dropped.name);
  }

  // Draft new entries for on-disk children that have no bullet yet. New
  // entries are always emitted with the `<!-- draft -->` marker so the human
  // can spot them and curate before they ossify into "permanent" bullets.
  const newEntries: BulletEntry[] = [];
  for (const child of children) {
    const canonical = canonicalName(child);
    if (shape.bullets.has(canonical)) continue;
    if (result.renames.some((r) => r.newName === canonical)) continue;

    let draft: DraftResult;
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
    });
    result.added.push(canonical);
  }

  // Aggregate this directory's keyword footprint upward — frequency-counted
  // so the parent pass can rank candidates when the cap forces drops. Tags
  // from kept (curated *and* drafted) bullets here count as 1 each; descendant
  // contributions add their own counts.
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
  for (const [path, freq] of aggregatedKeywords) {
    if (path.startsWith(dirAbsPath + '/')) {
      for (const [t, n] of freq) bumpTag(t, n);
    }
  }
  aggregatedKeywords.set(dirAbsPath, myAggregate);

  // For *existing* subdir bullets, re-derive tags from the descendant
  // aggregate when (a) the bullet is drafted (engine-owned), or (b) we're in
  // --rewrite-aggregated migration mode. Curated bullets are left alone.
  for (const child of children) {
    if (child.kind !== 'directory') continue;
    const canonical = canonicalName(child);
    const bullet = shape.bullets.get(canonical);
    if (!bullet) continue;
    const isEngineOwned = bullet.draft || rewriteAggregated;
    if (!isEngineOwned) continue;

    const childFreq = aggregatedKeywords.get(child.absPath) ?? new Map();
    const ranked = rankAggregatedTags(childFreq);
    const newTags = ranked.kept;

    // Compute the diff for the change report.
    const additions = newTags.filter((t) => !bullet.tags.includes(t));
    const removals = bullet.tags.filter((t) => !newTags.includes(t));

    // Promote a curated-but-rewritten bullet to drafted: --rewrite-aggregated
    // is the explicit "I want the engine to own this from now on" signal.
    const becameDraft = !bullet.draft;
    const willBeDraft = bullet.draft || rewriteAggregated;
    const newRaw = replaceTagsInBullet(bullet.raw, newTags, willBeDraft);

    if (newRaw !== bullet.raw) {
      bullet.tags = newTags;
      bullet.raw = newRaw;
      bullet.draft = willBeDraft;
      if (additions.length > 0 || removals.length > 0 || becameDraft) {
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

  // Render the new file content if anything changed.
  const changed =
    isNew || result.added.length > 0 || result.dropped.length > 0 || result.tagsAdded.length > 0;

  if (changed) {
    const rendered = renderIndex(shape, newEntries);
    if (!dryRun) {
      await atomicWrite(indexPath, rendered);
    }
  }

  result.created = isNew && (changed || true); // creating a new index is always "changed"
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
  const sections: SectionRange[] = [];
  const bullets = new Map<string, BulletEntry>();

  // Walk the file collecting heading offsets.
  const headingPositions: { line: number; heading: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
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
      const line = lines[i];
      const m = matchBullet(line);
      if (!m) continue;
      const rawName = m.name.trim();
      const link = m.link.trim();
      const isDir = rawName.endsWith('/') || link.endsWith('/index.md');
      if (isDir) dirCount++;
      else fileCount++;
      const tags = parseTagList(m.tags);
      const canonical = canonicalNameFromBullet(rawName, link);
      bullets.set(canonical, {
        name: rawName,
        raw: line,
        tags,
        sectionHeading: section.heading,
        draft: m.draft,
      });
    }
    if (dirCount === 0 && fileCount === 0) section.kind = 'empty';
    else if (dirCount > 0 && fileCount === 0) section.kind = 'dir';
    else if (fileCount > 0 && dirCount === 0) section.kind = 'file';
    else section.kind = 'mixed';
  }

  return { lines, sections, bullets };
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
    if (section.headingLine === -1) continue; // prologue, no bullets to manage

    // Find the contiguous bullet-block within this section.
    let bulletStart = -1;
    let bulletEnd = -1;
    for (let i = section.contentStart; i < section.contentEnd; i++) {
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
    // augmented) raw form.
    if (bulletStart !== -1) {
      const newBulletLines: string[] = [];
      for (let i = bulletStart; i < bulletEnd; i++) {
        const m = matchBullet(lines[i]);
        if (!m) {
          newBulletLines.push(lines[i]);
          continue;
        }
        const canonical = canonicalNameFromBullet(m.name.trim(), m.link.trim());
        const bullet = shape.bullets.get(canonical);
        if (!bullet) continue; // dropped
        if (!keptCanonical.has(canonical)) continue;
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

  // Ensure exactly one trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'local', 'notes']);

async function listAllDirectories(rootPath: string): Promise<string[]> {
  const out: string[] = [rootPath];
  await walk(rootPath);
  return out;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // Project item dirs (`YYYY-MM-DD-slug/`) carry a README.md, not an
      // index.md — they are *children* listed in the month index but not
      // directories the engine writes into. Skip both the push and the
      // recursion. `notes/` lives below them and is in SKIP_DIR_NAMES already.
      if (/^\d{4}-\d{2}-\d{2}-/.test(entry.name)) continue;
      const full = join(dir, entry.name);
      out.push(full);
      await walk(full);
    }
  }
}

async function listChildren(dirAbsPath: string, strategy: IndexStrategy): Promise<ChildInfo[]> {
  const out: ChildInfo[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dirAbsPath, { withFileTypes: true });
  } catch {
    return out;
  }
  const isMonthDir = strategy.treeName === 'projects' && /^\d{4}-\d{2}$/.test(basename(dirAbsPath));
  const isProjectsRoot = strategy.treeName === 'projects' && basename(dirAbsPath) === 'projects';
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'index.md') continue;
    const full = join(dirAbsPath, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // For projects root: only month dirs are children. For month dirs:
      // only item dirs are children. For knowledge: everything is.
      if (isProjectsRoot && !/^\d{4}-\d{2}$/.test(entry.name)) continue;
      out.push({ kind: 'directory', name: entry.name, absPath: full });
    } else if (entry.isFile()) {
      // Project month dirs and project item dirs have no body files at the
      // index level. Knowledge does.
      if (strategy.treeName === 'projects' && (isMonthDir || isProjectsRoot)) continue;
      if (entry.name.toLowerCase().endsWith('.md')) {
        out.push({ kind: 'file', name: entry.name, absPath: full });
      }
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function canonicalName(child: ChildInfo): string {
  return child.kind === 'directory' ? `${child.name}/` : child.name;
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

function replaceTagsInBullet(raw: string, tags: string[], isDraft: boolean): string {
  // Strip any trailing draft marker plus any other trailing HTML comments
  // (e.g. a curated `<!-- TBC -->`) so the tag-block regex sees clean input.
  // The non-draft trailing comments are preserved and re-appended after the
  // tag block — same position relative to the bullet body.
  let stripped = raw.replace(DRAFT_MARKER_RE, '');
  const trailingComments: string[] = [];
  let m: RegExpMatchArray | null;
  while ((m = stripped.match(TRAILING_COMMENT_RE))) {
    trailingComments.unshift(m[0].trim());
    stripped = stripped.replace(TRAILING_COMMENT_RE, '');
  }
  const tagBlock = ` \`[${tags.join(', ')}]\``;
  let body: string;
  if (/\s*`?\[[^\]]*\]`?\s*$/.test(stripped)) {
    body = stripped.replace(/\s*`?\[[^\]]*\]`?\s*$/, '') + tagBlock;
  } else {
    body = stripped + tagBlock;
  }
  const preservedTrail = trailingComments.length > 0 ? ' ' + trailingComments.join(' ') : '';
  return isDraft ? `${body} ${DRAFT_MARKER}${preservedTrail}` : `${body}${preservedTrail}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${Date.now()}.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}
