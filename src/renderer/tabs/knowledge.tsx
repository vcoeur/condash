import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { KnowledgeNode, SearchHit, SearchResults, SearchSnippet } from '@shared/types';
import { BookIcon } from '../icons';
import { HighlightedText } from '../search/highlight';
import './knowledge-tab.css';

/* Knowledge tab — flat card list grouped one section per directory. The
 * chrome (section header capsule, card silhouette, hover-brighten) mirrors
 * the Code and Projects tabs so the three tabs feel like one app. The
 * directory's `index.md` (when present) is surfaced as an [INDEX] badge
 * on the section header — clicking it opens the index file.
 *
 * Filter: an empty query renders the directory groupings. A non-empty
 * query routes to the global-search backend (`window.condash.search`) so
 * the user gets the same ranked AND/phrase semantics, region weighting,
 * and snippet highlights as the ⌘K modal — restricted to knowledge hits. */

const EMPTY_RESULTS: SearchResults = { hits: [], terms: [], totalBeforeCap: 0, truncated: false };

type BucketId = 'general' | 'internal' | 'topics' | 'external';

interface KnowledgeFile {
  node: KnowledgeNode;
  bucket: BucketId;
}

interface KnowledgeSection {
  id: string;
  label: string;
  bucket: BucketId;
  index?: KnowledgeNode;
  files: KnowledgeFile[];
}

const BUCKET_ORDER: readonly BucketId[] = ['general', 'internal', 'topics', 'external'];

function bucketOf(relPath: string): BucketId {
  if (relPath.startsWith('internal')) return 'internal';
  if (relPath.startsWith('external')) return 'external';
  if (relPath.startsWith('topics')) return 'topics';
  return 'general';
}

function buildSections(root: KnowledgeNode | null): KnowledgeSection[] {
  if (!root) return [];

  const sectionsByDir = new Map<string, KnowledgeSection>();
  const general: KnowledgeFile[] = [];

  const visit = (node: KnowledgeNode, dirRel: string): void => {
    if (node.kind === 'file') return;
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
      for (const f of contentNodes) general.push({ node: f, bucket: 'general' });
    } else if (contentNodes.length > 0 || indexNode) {
      const bucket = bucketOf(dirRel);
      const label = dirRel.split('/').join(' · ').toUpperCase();
      const files: KnowledgeFile[] = contentNodes
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((n) => ({ node: n, bucket }));
      sectionsByDir.set(dirRel, { id: dirRel, label, bucket, index: indexNode, files });
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
  const rest = Array.from(sectionsByDir.values());
  rest.sort((a, b) => {
    const ai = BUCKET_ORDER.indexOf(a.bucket);
    const bi = BUCKET_ORDER.indexOf(b.bucket);
    if (ai !== bi) return ai - bi;
    return a.id.localeCompare(b.id);
  });
  return out.concat(rest);
}

/** Walk the tree and emit every file node by absolute path so search hits
 * (which know `hit.path` only) can be mapped back to the loaded
 * KnowledgeNode that already has summary + verifiedAt extracted. */
function indexNodesByPath(root: KnowledgeNode | null): Map<string, KnowledgeNode> {
  const out = new Map<string, KnowledgeNode>();
  if (!root) return out;
  const visit = (node: KnowledgeNode): void => {
    if (node.kind === 'file') {
      out.set(node.path, node);
      return;
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

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
  /** Live search-input value, owned by the toolbar. Debounced internally
   * to a `query` signal that drives the actual backend fetch. */
  searchInput: string;
  onOpen: (path: string, title?: string) => void;
}) {
  const [query, setQuery] = createSignal('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  createEffect(() => {
    const value = props.searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setQuery(value), 200);
  });
  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const todayISO = new Date().toISOString().slice(0, 10);

  // Manual signal-based fetch (not createResource): the parent Suspense
  // boundary in main.tsx would otherwise catch every re-fetch and unmount
  // this view + the input on each keystroke, killing focus mid-typing.
  const [results, setResults] = createSignal<SearchResults>(EMPTY_RESULTS);
  const [searching, setSearching] = createSignal(false);

  createEffect(() => {
    const q = query();
    if (q.trim().length === 0) {
      setResults(EMPTY_RESULTS);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    void window.condash.search(q).then((r) => {
      if (cancelled) return;
      setResults(r);
      setSearching(false);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  const sections = createMemo<KnowledgeSection[]>(() => buildSections(props.root));
  const nodesByPath = createMemo<Map<string, KnowledgeNode>>(() => indexNodesByPath(props.root));

  /** Knowledge-only hits (skip project hits) — already score-sorted by the
   * backend. We map each hit back to the loaded KnowledgeNode so the card
   * can carry the same summary / verified pill that the unfiltered view
   * shows; if the hit has no loaded node (e.g. a freshly added file the
   * tree hasn't refreshed for yet) we fall back to a card synthesised
   * from the hit's title + relPath. */
  const knowledgeHits = createMemo<SearchHit[]>(() =>
    results().hits.filter((h) => h.source === 'knowledge'),
  );

  const isSearching = (): boolean => props.searchInput.trim().length > 0;

  return (
    <div class="knowledge-pane">
      <Show
        when={isSearching()}
        fallback={<DirectoryView sections={sections()} todayISO={todayISO} onOpen={props.onOpen} />}
      >
        <Show when={searching() && knowledgeHits().length === 0}>
          <div class="empty">Searching…</div>
        </Show>
        <Show
          when={knowledgeHits().length > 0}
          fallback={
            <Show when={!searching()}>
              <div class="empty">No matches.</div>
            </Show>
          }
        >
          <section class="knowledge-group" data-bucket="search">
            <h2 class="knowledge-section-header">
              <span class="name">RESULTS</span>
              <span class="count">{knowledgeHits().length}</span>
              <span class="rule" />
            </h2>
            <div class="knowledge-grid">
              <For each={knowledgeHits()}>
                {(hit) => (
                  <SearchKnowledgeCard
                    hit={hit}
                    node={nodesByPath().get(hit.path)}
                    todayISO={todayISO}
                    onOpen={() => props.onOpen(hit.path, hit.title)}
                  />
                )}
              </For>
            </div>
          </section>
        </Show>
      </Show>
    </div>
  );
}

function DirectoryView(props: {
  sections: KnowledgeSection[];
  todayISO: string;
  onOpen: (path: string, title?: string) => void;
}) {
  return (
    <For each={props.sections}>
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
                  todayISO={props.todayISO}
                  onOpen={() => props.onOpen(file.node.path, file.node.title)}
                />
              )}
            </For>
          </div>
        </section>
      )}
    </For>
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

/** Search-result variant of KnowledgeCard: same shell, but the title gets
 * `<mark>`-style highlights from `hit.snippets[*].matches` (when the title
 * region matched) and the body shows backend snippets in score order
 * instead of the lead-paragraph caption. */
function SearchKnowledgeCard(props: {
  hit: SearchHit;
  node: KnowledgeNode | undefined;
  todayISO: string;
  onOpen: () => void;
}) {
  const bucket = (): BucketId => bucketOf(props.hit.relPath.replace(/^knowledge\//, ''));
  const verifiedAt = (): string | undefined => props.node?.verifiedAt;
  const fresh = (): string => freshnessOf(verifiedAt(), props.todayISO);
  // The h1 snippet (when present) carries the title's match offsets; reuse
  // them on the card head so the search highlight colour matches the body.
  const titleSnippet = (): SearchSnippet | undefined =>
    props.hit.snippets.find((s) => s.region === 'h1');
  const bodySnippets = (): SearchSnippet[] =>
    props.hit.snippets.filter((s) => s.region !== 'h1').slice(0, 3);

  return (
    <article
      class="knowledge-card knowledge-card-result"
      data-bucket={bucket()}
      title={props.hit.path}
      onClick={() => props.onOpen()}
    >
      <header class="knowledge-card-head">
        <span class="knowledge-card-glyph" aria-hidden="true">
          <BookIcon />
        </span>
        <h3 class="knowledge-card-title">
          <Show when={titleSnippet()} fallback={props.hit.title}>
            {(s) => <HighlightedText text={s().text} matches={s().matches} />}
          </Show>
        </h3>
        <Show when={verifiedAt()}>
          <span
            class="knowledge-card-verified"
            data-fresh={fresh()}
            title={`Verified ${verifiedAt()}`}
          >
            <span class="knowledge-card-verified-label">Verified</span>{' '}
            <span class="knowledge-card-verified-date">{verifiedAt()}</span>
          </span>
        </Show>
      </header>
      <Show when={bodySnippets().length > 0}>
        <ul class="knowledge-card-snippets">
          <For each={bodySnippets()}>
            {(s) => (
              <li
                classList={{
                  'snippet-meta': s.region === 'meta',
                  'snippet-heading': s.region === 'heading',
                  'snippet-path': s.region === 'path',
                }}
              >
                <Show when={s.region === 'meta'}>
                  <span class="snippet-region-tag">meta</span>
                </Show>
                <Show when={s.region === 'heading'}>
                  <span class="snippet-region-tag">heading</span>
                </Show>
                <HighlightedText text={s.text} matches={s.matches} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.hit.pathMatches && props.hit.pathMatches.length > 0}>
        <p class="knowledge-card-path-line">
          <HighlightedText
            text={props.hit.relPath}
            matches={props.hit.pathMatches!}
            markClass="dim"
          />
        </p>
      </Show>
    </article>
  );
}
