import { createMemo, createSignal, For, Show } from 'solid-js';
import type { KnowledgeNode } from '@shared/types';
import { BookIcon } from '../icons';
import './knowledge-tab.css';

/* Knowledge tab — flat card list grouped one section per directory. The
 * chrome (section header capsule, card silhouette, hover-brighten) mirrors
 * the Code and Projects tabs so the three tabs feel like one app. The
 * directory's `index.md` (when present) is surfaced as an [INDEX] badge
 * on the section header — clicking it opens the index file. */

type BucketId = 'general' | 'internal' | 'topics' | 'external';

interface KnowledgeFile {
  node: KnowledgeNode;
  bucket: BucketId;
}

interface KnowledgeSection {
  /** Internal id — `general`, `internal`, `topics/ops`, `external`, … */
  id: string;
  /** Display label — `GENERAL`, `INTERNAL`, `TOPICS · OPS`, … */
  label: string;
  /** Top-level bucket (drives the per-section stripe colour). */
  bucket: BucketId;
  /** The directory's index.md, if any. */
  index?: KnowledgeNode;
  /** Non-index files in the directory. */
  files: KnowledgeFile[];
}

const BUCKET_ORDER: readonly BucketId[] = ['general', 'internal', 'topics', 'external'];

function bucketOf(relPath: string): BucketId {
  if (relPath.startsWith('internal')) return 'internal';
  if (relPath.startsWith('external')) return 'external';
  if (relPath.startsWith('topics')) return 'topics';
  return 'general';
}

/** Walk the tree and produce one section per directory that has at least
 * one non-index .md file. The directory's own index.md (if present) is
 * stashed on `section.index` rather than emitted as a card. Root-level
 * non-index files (e.g. `conventions.md`) land in the synthetic
 * `GENERAL` section. */
function buildSections(root: KnowledgeNode | null): KnowledgeSection[] {
  if (!root) return [];

  const sectionsByDir = new Map<string, KnowledgeSection>();
  const general: KnowledgeFile[] = [];

  const visit = (node: KnowledgeNode, dirRel: string): void => {
    if (node.kind === 'file') return; // handled by the parent directory pass
    const isRoot = dirRel === '';
    const childDirs: KnowledgeNode[] = [];
    const childFiles: KnowledgeNode[] = [];
    for (const child of node.children ?? []) {
      if (child.kind === 'directory') childDirs.push(child);
      else childFiles.push(child);
    }
    let indexNode: KnowledgeNode | undefined;
    const contentNodes: KnowledgeNode[] = [];
    for (const f of childFiles) {
      if (f.name.toLowerCase() === 'index.md') indexNode = f;
      else contentNodes.push(f);
    }

    if (isRoot) {
      // Root content (non-index .md at knowledge/) → GENERAL.
      for (const f of contentNodes) {
        general.push({ node: f, bucket: 'general' });
      }
    } else if (contentNodes.length > 0 || indexNode) {
      // Emit a section for any directory that has either content files or
      // an index — the index alone (e.g. `topics/index.md` over a folder
      // of sub-categories) is enough to deserve a visible INDEX badge.
      const bucket = bucketOf(dirRel);
      const label = dirRel.split('/').join(' · ').toUpperCase();
      const files: KnowledgeFile[] = contentNodes
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((n) => ({ node: n, bucket }));
      sectionsByDir.set(dirRel, {
        id: dirRel,
        label,
        bucket,
        index: indexNode,
        files,
      });
    }

    for (const sub of childDirs) {
      const childRel = dirRel ? `${dirRel}/${sub.name}` : sub.name;
      visit(sub, childRel);
    }
  };
  visit(root, '');

  const out: KnowledgeSection[] = [];
  if (general.length > 0) {
    out.push({
      id: 'general',
      label: 'GENERAL',
      bucket: 'general',
      files: general.sort((a, b) => a.node.title.localeCompare(b.node.title)),
    });
  }
  // Order: GENERAL, then by bucket order, then by section id alphabetically
  // within each bucket so `topics/ops` < `topics/security` < `topics/testing`.
  const rest = Array.from(sectionsByDir.values());
  rest.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  return out.concat(rest);
}

function fileMatches(file: KnowledgeNode, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${file.title} ${file.relPath} ${file.summary ?? ''}`.toLowerCase();
  return haystack.includes(needle);
}

/** Filter a section's content files (and optionally the index.md). When
 * the section has no surviving cards but the index matches, we still
 * keep the section visible so the badge remains reachable. */
function filterSection(section: KnowledgeSection, needle: string): KnowledgeSection | null {
  if (!needle) return section;
  const files = section.files.filter((f) => fileMatches(f.node, needle));
  const indexHit = section.index ? fileMatches(section.index, needle) : false;
  if (files.length === 0 && !indexHit) return null;
  return { ...section, files };
}

/** Bucket "verified" freshness so the stamp pill can dim with age:
 *  fresh < 90 days · stale 90-365 · old > 365 · undefined when no stamp. */
function freshnessOf(verifiedAt: string | undefined, todayISO: string): string {
  if (!verifiedAt) return 'none';
  const t = Date.parse(`${todayISO}T00:00:00Z`);
  const v = Date.parse(`${verifiedAt}T00:00:00Z`);
  if (Number.isNaN(t) || Number.isNaN(v)) return 'none';
  const days = Math.floor((t - v) / 86_400_000);
  if (days < 90) return 'fresh';
  if (days < 365) return 'stale';
  return 'old';
}

export function KnowledgeView(props: {
  root: KnowledgeNode;
  onOpen: (path: string, title?: string) => void;
}) {
  const [filter, setFilter] = createSignal('');
  const trimmed = createMemo(() => filter().trim().toLowerCase());
  const todayISO = new Date().toISOString().slice(0, 10);

  const sections = createMemo<KnowledgeSection[]>(() => buildSections(props.root));
  const filtered = createMemo<KnowledgeSection[]>(() => {
    const q = trimmed();
    return sections()
      .map((s) => filterSection(s, q))
      .filter((s): s is KnowledgeSection => s !== null);
  });

  return (
    <div class="knowledge-pane">
      <div class="projects-filter">
        <input
          class="projects-filter-input"
          type="search"
          placeholder="Filter knowledge (title, path, summary)…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <Show
        when={filtered().length > 0}
        fallback={<div class="empty">No knowledge entries match.</div>}
      >
        <For each={filtered()}>
          {(section) => (
            <section class="knowledge-group" data-bucket={section.bucket}>
              <h2 class="knowledge-section-header">
                <span class="name">{section.label}</span>
                <Show when={section.files.length > 0}>
                  <span class="count">{section.files.length}</span>
                </Show>
                <Show when={section.index}>
                  {(idx) => (
                    <button
                      type="button"
                      class="knowledge-section-index"
                      onClick={() => props.onOpen(idx().path, idx().title)}
                      title={`Open ${section.label.toLowerCase()} index`}
                    >
                      INDEX
                    </button>
                  )}
                </Show>
                <span class="rule" />
              </h2>
              <div class="knowledge-grid">
                <For each={section.files}>
                  {(file) => (
                    <KnowledgeCard
                      file={file}
                      todayISO={todayISO}
                      onOpen={() => props.onOpen(file.node.path, file.node.title)}
                    />
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function KnowledgeCard(props: { file: KnowledgeFile; todayISO: string; onOpen: () => void }) {
  const fresh = (): string => freshnessOf(props.file.node.verifiedAt, props.todayISO);
  return (
    <article
      class="knowledge-card"
      data-bucket={props.file.bucket}
      title={props.file.node.path}
      onClick={() => props.onOpen()}
    >
      <header class="knowledge-card-head">
        <span class="knowledge-card-glyph" aria-hidden="true">
          <BookIcon />
        </span>
        <h3 class="knowledge-card-title">{props.file.node.title}</h3>
        <Show when={props.file.node.verifiedAt}>
          <span
            class="knowledge-card-verified"
            data-fresh={fresh()}
            title={`Verified ${props.file.node.verifiedAt}`}
          >
            <span class="knowledge-card-verified-label">Verified</span>{' '}
            <span class="knowledge-card-verified-date">{props.file.node.verifiedAt}</span>
          </span>
        </Show>
      </header>
      <Show when={props.file.node.summary}>
        <p class="knowledge-card-summary">{props.file.node.summary}</p>
      </Show>
    </article>
  );
}
