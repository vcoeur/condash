import { createMemo, createSignal, For, Show } from 'solid-js';
import type { KnowledgeNode } from '@shared/types';
import './knowledge-tab.css';

/** Prune `node` to only the subtree where some descendant title or path
 * matches `needle`. Returns null when nothing in the subtree matches. */
function filterKnowledgeTree(node: KnowledgeNode, needle: string): KnowledgeNode | null {
  if (!needle) return node;
  const titleHit = node.title.toLowerCase().includes(needle);
  const pathHit = node.path.toLowerCase().includes(needle);
  if (node.kind === 'file') {
    return titleHit || pathHit ? node : null;
  }
  const children = (node.children ?? [])
    .map((c) => filterKnowledgeTree(c, needle))
    .filter((c): c is KnowledgeNode => c !== null);
  if (children.length === 0 && !titleHit && !pathHit) return null;
  return { ...node, children };
}

export function KnowledgeView(props: { root: KnowledgeNode; onOpen: (path: string) => void }) {
  const [filter, setFilter] = createSignal('');
  const trimmed = createMemo(() => filter().trim().toLowerCase());
  const filteredRoot = createMemo<KnowledgeNode | null>(() =>
    filterKnowledgeTree(props.root, trimmed()),
  );
  return (
    <div class="knowledge-pane">
      <div class="projects-filter">
        <input
          class="projects-filter-input"
          type="search"
          placeholder="Filter knowledge (title, path)…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <Show when={filteredRoot()} fallback={<div class="empty">No knowledge entries match.</div>}>
        <ul class="knowledge-tree knowledge-tree-root">
          <KnowledgeNodeView
            node={filteredRoot()!}
            depth={0}
            onOpen={props.onOpen}
            initiallyExpanded
            forceExpand={trimmed().length > 0}
          />
        </ul>
      </Show>
    </div>
  );
}

function KnowledgeNodeView(props: {
  node: KnowledgeNode;
  depth: number;
  onOpen: (path: string) => void;
  initiallyExpanded?: boolean;
  /** When true, ignore the local toggle and expand — used so a search filter
   * surfaces matches no matter how the user previously collapsed branches. */
  forceExpand?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(props.initiallyExpanded ?? props.depth === 0);
  const isExpanded = (): boolean => props.forceExpand || expanded();

  return (
    <li class="knowledge-node" data-kind={props.node.kind}>
      <Show
        when={props.node.kind === 'directory'}
        fallback={
          <button
            class="knowledge-leaf"
            onClick={() => props.onOpen(props.node.path)}
            title={props.node.path}
          >
            <span class="knowledge-icon">📄</span>
            <span class="knowledge-title">{props.node.title}</span>
          </button>
        }
      >
        <button class="knowledge-dir" onClick={() => setExpanded((v) => !v)}>
          <span class="knowledge-icon">{isExpanded() ? '▾' : '▸'}</span>
          <span class="knowledge-title">{props.node.title}</span>
          <Show when={props.node.children}>
            <span class="knowledge-count">{props.node.children!.length}</span>
          </Show>
        </button>
        <Show when={isExpanded() && props.node.children}>
          <ul class="knowledge-tree">
            <For each={props.node.children}>
              {(child) => (
                <KnowledgeNodeView
                  node={child}
                  depth={props.depth + 1}
                  onOpen={props.onOpen}
                  forceExpand={props.forceExpand}
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </li>
  );
}
