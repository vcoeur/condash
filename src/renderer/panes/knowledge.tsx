import { createMemo, Show } from 'solid-js';
import type { KnowledgeNode } from '@shared/types';
import { BookIcon } from '../icons';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './knowledge-pane.css';

/* Knowledge pane — collapsible directory tree (issue #89). The pane keeps
 * its current card silhouette (bucket-coloured stripe, freshness chip,
 * one-line summary) and surfaces every directory's `index.md` as the
 * `[INDEX]` badge on that directory's header. The tree itself lives in
 * the shared `TreeView` component. */

type BucketId = 'general' | 'internal' | 'topics' | 'external';

const KNOWLEDGE_AFFORDANCES: ReadonlyArray<TreeAffordance> = ['createMd', 'mkdir'];

function bucketOf(relPath: string): BucketId {
  if (relPath.startsWith('internal')) return 'internal';
  if (relPath.startsWith('external')) return 'external';
  if (relPath.startsWith('topics')) return 'topics';
  return 'general';
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

function isKnowledgeIndex(node: KnowledgeNode): boolean {
  return node.kind === 'file' && node.name.toLowerCase() === 'index.md';
}

const todayISO = new Date().toISOString().slice(0, 10);

export function KnowledgeView(props: {
  root: KnowledgeNode;
  onOpen: (path: string, title?: string) => void;
  expanded: () => ReadonlySet<string>;
  onToggleExpand: (relPath: string) => void;
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  onError: (message: string) => void;
}) {
  const scrollRef = usePaneScrollMemory('knowledge');

  // Wrap pane-level callbacks in createMemo so prop identity stays stable
  // across unrelated parent re-runs (e.g. `expanded` flips). Without this,
  // every toggle re-creates these arrows, invalidates DirectoryBody's
  // specialChild / childFiles memos, and forces <For> to re-render every
  // file card in the directory. See notes/01-design.md.
  const renderSpecialFile = createMemo(() => (file: KnowledgeNode, dir: KnowledgeNode) => (
    <button
      type="button"
      class="tree-special-file knowledge-special-file"
      data-bucket={bucketOf(dir.relPath)}
      onClick={(e) => {
        e.stopPropagation();
        props.onOpen(file.path, file.title);
      }}
      title={`Open ${dir.relPath || 'knowledge'} index`}
    >
      <span class="tree-special-badge">INDEX</span>
      <span class="tree-special-title">{file.title}</span>
      <Show when={file.verifiedAt}>
        <span
          class="tree-special-meta"
          data-fresh={freshnessOf(file.verifiedAt, todayISO)}
          title={`Verified ${file.verifiedAt}`}
        >
          {file.verifiedAt}
        </span>
      </Show>
    </button>
  ));
  const renderFile = createMemo(() => (file: KnowledgeNode) => (
    <KnowledgeCard
      node={file}
      todayISO={todayISO}
      onOpen={() => props.onOpen(file.path, file.title)}
    />
  ));

  return (
    <div class="knowledge-pane" ref={scrollRef}>
      <TreeView<KnowledgeNode>
        treeKey="knowledge"
        root={props.root}
        expanded={props.expanded}
        onToggleExpand={props.onToggleExpand}
        affordances={KNOWLEDGE_AFFORDANCES}
        mutations={props.mutations}
        prompts={props.prompts}
        onAfterMutation={props.onAfterMutation}
        onError={props.onError}
        specialFile={isKnowledgeIndex}
        renderSpecialFile={renderSpecialFile()}
        renderFile={renderFile()}
      />
    </div>
  );
}

function KnowledgeCard(props: { node: KnowledgeNode; todayISO: string; onOpen: () => void }) {
  const fresh = (): string => freshnessOf(props.node.verifiedAt, props.todayISO);
  const bucket = (): BucketId => bucketOf(props.node.relPath);
  return (
    <article
      class="knowledge-card card"
      data-bucket={bucket()}
      title={props.node.path}
      onClick={() => props.onOpen()}
    >
      <header class="knowledge-card-head">
        <span class="knowledge-card-glyph" aria-hidden="true">
          <BookIcon />
        </span>
        <h3 class="knowledge-card-title">{props.node.title}</h3>
        <Show when={props.node.verifiedAt}>
          <span
            class="knowledge-card-verified"
            data-fresh={fresh()}
            title={`Verified ${props.node.verifiedAt}`}
          >
            <span class="knowledge-card-verified-label">Verified</span>{' '}
            <span class="knowledge-card-verified-date">{props.node.verifiedAt}</span>
          </span>
        </Show>
      </header>
      <Show when={props.node.summary}>
        <p class="knowledge-card-summary">{props.node.summary}</p>
      </Show>
    </article>
  );
}
