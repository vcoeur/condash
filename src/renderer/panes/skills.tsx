import { createMemo, For, Show, type JSX } from 'solid-js';
import type { SkillNode, SkillScope } from '@shared/types';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './skills-pane.css';

// The Skills pane is read-only in both scopes (user decision 2026-05-23,
// preserved through the reframe): it surfaces agedum source-of-truth and
// never edits — agedum owns writes.
const READONLY_AFFORDANCES: ReadonlyArray<TreeAffordance> = [];

// Scope toggle order. `conception` first (the default).
const SCOPE_ORDER: ReadonlyArray<SkillScope> = ['conception', 'user'];
const SCOPE_LABELS: Record<SkillScope, string> = {
  conception: 'Conception',
  user: 'User',
};

function isSkillIndex(node: SkillNode): boolean {
  // Case-sensitive — that's how the manifest stores it and how
  // `condash skills install` reasons about file identity.
  return node.kind === 'file' && node.name === 'SKILL.md';
}

/** Strip the `__sentinel__/` prefix off the injected AGENTS.md relPath for
 *  display (`__agents__/AGENTS.md` → `AGENTS.md`). */
function configMeta(relPath: string): string {
  return relPath.replace(/^__[^/]+__\//, '');
}

export function SkillsView(props: {
  scope: SkillScope;
  onSelectScope: (scope: SkillScope) => void;
  /** Reload the active scope's tree. */
  onRefresh: () => void;
  root: SkillNode | null;
  onOpen: (path: string, title: string, shipped?: SkillNode['shipped']) => void;
  /** Copy the install command to the clipboard so the user can paste into
   *  the embedded terminal. */
  onCopyInstallCommand?: () => void;
  expanded: () => ReadonlySet<string>;
  onToggleExpand: (relPath: string) => void;
  mutations: TreeViewMutationApi;
  prompts: TreeViewPromptApi;
  onAfterMutation: (newPath: string, kind: TreeAffordance, sourceDirRelPath: string) => void;
  onError: (message: string) => void;
}) {
  // Per-scope scroll memory so flipping scopes restores the prior position.
  const scrollRef = usePaneScrollMemory(() => `skills-${props.scope}`);

  // The pinned AGENTS.md (badge != null) is lifted out of the tree into its
  // own band above it — TreeView only ever promotes one special file per
  // directory, and we want it independent of the skills tree itself.
  const configNodes = createMemo<SkillNode[]>(() =>
    (props.root?.children ?? []).filter((c) => c.badge != null),
  );
  const treeRoot = createMemo<SkillNode | null>(() => {
    const root = props.root;
    if (!root) return null;
    return { ...root, children: (root.children ?? []).filter((c) => c.badge == null) };
  });

  const renderConfigCallout = (file: SkillNode): JSX.Element => (
    <button
      type="button"
      class="tree-special-file claude-special-file"
      onClick={() => props.onOpen(file.path, file.title, file.shipped)}
      title={`Open ${file.path}`}
      aria-label={`Open ${file.path}`}
    >
      <span class="tree-special-badge">{file.badge}</span>
      <span class="tree-special-title">{file.title}</span>
      <span class="tree-special-meta">{configMeta(file.relPath)}</span>
    </button>
  );

  // SKILL.md is promoted from any sub-skill directory (not at the root).
  const specialFile = createMemo(
    () =>
      (file: SkillNode, dir: SkillNode): boolean =>
        dir.relPath !== '' && isSkillIndex(file),
  );
  const renderSpecialFile = createMemo(() => (file: SkillNode, dir: SkillNode) => {
    const shipped = file.shipped;
    return (
      <button
        type="button"
        class="tree-special-file skill-special-file"
        classList={{
          shipped: !!shipped,
          diverged: !!shipped?.diverged,
        }}
        onClick={(e) => {
          e.stopPropagation();
          props.onOpen(file.path, file.title, shipped);
        }}
        aria-label={`Open SKILL.md for ${dir.relPath || 'skills'}${
          shipped?.diverged ? ' (shipped, locally edited)' : shipped ? ' (shipped)' : ''
        }`}
        title={
          shipped?.diverged
            ? 'SKILL.md (shipped, locally edited)'
            : shipped
              ? 'SKILL.md (shipped)'
              : 'SKILL.md'
        }
      >
        <span class="tree-special-badge">SKILL</span>
        <span class="tree-special-title">{file.title}</span>
        <Show when={shipped}>
          <span class="tree-special-meta">{shipped?.diverged ? 'diverged' : 'shipped'}</span>
        </Show>
      </button>
    );
  });
  const renderFile = createMemo(() => (file: SkillNode) => (
    <SkillCard node={file} onOpen={() => props.onOpen(file.path, file.title, file.shipped)} />
  ));

  const emptyState = () => (
    <div class="empty">
      <p>No skills available.</p>
      <Show
        when={props.scope === 'conception'}
        fallback={
          <p>
            User-scope skills live at <code>~/.config/agents/skills/</code>. Edit them via your agedum
            sources.
          </p>
        }
      >
        <p>
          Run <code>condash skills install</code> to lay down the shipped skills under{' '}
          <code>.agents/skills/</code>.
        </p>
      </Show>
      <Show when={props.scope === 'conception' && props.onCopyInstallCommand}>
        <div class="empty-actions">
          <button type="button" class="empty-cta" onClick={() => props.onCopyInstallCommand?.()}>
            Copy install command
          </button>
        </div>
      </Show>
    </div>
  );

  return (
    <div class="skills-pane">
      <div class="skills-scope-row">
        <div class="seg" role="group" aria-label="Skill scope">
          <For each={SCOPE_ORDER}>
            {(scope) => (
              <button
                type="button"
                class="seg-item"
                classList={{ 'seg-item--active': props.scope === scope }}
                aria-pressed={props.scope === scope}
                onClick={() => props.onSelectScope(scope)}
              >
                {SCOPE_LABELS[scope]}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="skills-refresh"
          onClick={() => props.onRefresh()}
          title="Refresh"
          aria-label="Refresh skills"
        >
          ↻
        </button>
      </div>
      <div class="skills-tree" ref={scrollRef}>
        <Show when={props.root} fallback={emptyState()}>
          <Show when={configNodes().length > 0}>
            <div class="skills-config-band">
              <For each={configNodes()}>{(file) => renderConfigCallout(file)}</For>
            </div>
          </Show>
          <Show when={treeRoot() && (treeRoot()!.children?.length ?? 0) > 0}>
            <TreeView<SkillNode>
              treeKey="skills"
              root={treeRoot()!}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              affordances={READONLY_AFFORDANCES}
              mutations={props.mutations}
              prompts={props.prompts}
              onAfterMutation={props.onAfterMutation}
              onError={props.onError}
              specialFile={specialFile()}
              renderSpecialFile={renderSpecialFile()}
              renderFile={renderFile()}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}

function SkillCard(props: { node: SkillNode; onOpen: () => void }) {
  const shippedStatus = (): 'none' | 'clean' | 'diverged' => {
    const s = props.node.shipped;
    if (!s) return 'none';
    return s.diverged ? 'diverged' : 'clean';
  };

  return (
    <article
      class="skills-card"
      data-shipped={shippedStatus()}
      data-kind="md"
      title={props.node.path}
      tabIndex={0}
      role="button"
      aria-label={`Open skill ${props.node.title}`}
      onClick={() => props.onOpen()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          props.onOpen();
        }
      }}
    >
      <header class="skills-card-head">
        <h3 class="skills-card-title">{props.node.title}</h3>
        <Show when={props.node.shipped}>
          {(stamp) => (
            <span
              class="skills-card-shipped"
              data-state={stamp().diverged ? 'diverged' : 'clean'}
              title={
                stamp().diverged
                  ? 'Shipped by condash — local edits will be flagged on `condash skills install`.'
                  : `Shipped by condash${stamp().shippedVersion ? ` (v${stamp().shippedVersion})` : ''}.`
              }
            >
              {stamp().diverged ? 'shipped · diverged' : 'shipped'}
            </span>
          )}
        </Show>
      </header>
      <p class="skills-card-relpath">{props.node.relPath}</p>
      <Show when={props.node.summary}>
        <p class="skills-card-summary">{props.node.summary}</p>
      </Show>
    </article>
  );
}
