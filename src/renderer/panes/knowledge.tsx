import { Show } from 'solid-js';
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

/** Return the directory's `index.md` child (case-insensitive on the
 *  filename), if any. Surfaced as the `[INDEX]` badge on the dir header
 *  and dropped from the file list so it doesn't double up as a card. */
function findIndexChild(node: KnowledgeNode): KnowledgeNode | undefined {
  for (const child of node.children ?? []) {
    if (child.kind === 'file' && child.name.toLowerCase() === 'index.md') return child;
  }
  return undefined;
}

/** Strip every `index.md` from the tree — it's already surfaced as the
 *  per-directory INDEX badge, and we don't want it doubling up as a
 *  card under the directory header. Returns a shallow-cloned tree so
 *  the original `KnowledgeNode` reference (held by the createResource)
 *  stays untouched. */
function stripIndexes(node: KnowledgeNode): KnowledgeNode {
  if (node.kind !== 'directory') return node;
  const filtered: KnowledgeNode[] = [];
  for (const child of node.children ?? []) {
    if (child.kind === 'file' && child.name.toLowerCase() === 'index.md') continue;
    filtered.push(stripIndexes(child));
  }
  return { ...node, children: filtered };
}

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
  const todayISO = new Date().toISOString().slice(0, 10);
  const scrollRef = usePaneScrollMemory('knowledge');

  return (
    <div class="knowledge-pane" ref={scrollRef}>
      <TreeView<KnowledgeNode>
        treeKey="knowledge"
        root={stripIndexes(props.root)}
        expanded={props.expanded}
        onToggleExpand={props.onToggleExpand}
        affordances={KNOWLEDGE_AFFORDANCES}
        mutations={props.mutations}
        prompts={props.prompts}
        onAfterMutation={props.onAfterMutation}
        onError={props.onError}
        renderDirSuffix={(dir) => (
          <Show when={findIndexChild(dir)}>
            {(idx) => (
              <button
                type="button"
                class="knowledge-section-index"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpen(idx().path, idx().title);
                }}
                title={`Open ${dir.relPath || 'knowledge'} index`}
              >
                INDEX
              </button>
            )}
          </Show>
        )}
        renderFile={(file) => (
          <KnowledgeCard
            node={file}
            todayISO={todayISO}
            onOpen={() => props.onOpen(file.path, file.title)}
          />
        )}
      />
    </div>
  );
}

function KnowledgeCard(props: { node: KnowledgeNode; todayISO: string; onOpen: () => void }) {
  const fresh = (): string => freshnessOf(props.node.verifiedAt, props.todayISO);
  const bucket = (): BucketId => bucketOf(props.node.relPath);
  return (
    <article
      class="knowledge-card"
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
