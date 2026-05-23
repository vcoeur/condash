import { createMemo, For, Show, type JSX } from 'solid-js';
import type { SkillNode, SkillScope, SkillTab } from '@shared/types';
import { SKILL_TABS } from '@shared/types';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './skills-pane.css';

// The Skills pane is read-only in both scopes (user decision 2026-05-23):
// it surfaces conception-local and per-machine-global skills + agent configs
// but never edits them. No tab gets create/mkdir/import affordances.
const READONLY_AFFORDANCES: ReadonlyArray<TreeAffordance> = [];

const TAB_LABELS: Record<SkillTab, string> = {
  generic: 'Generic',
  claude: 'Claude',
  kimi: 'Kimi',
  opencode: 'OpenCode',
};

// Scope toggle order (row 1). `global` first per the request; `local` is the
// default. Labels are deliberately terse to fit the segmented control.
const SCOPE_ORDER: ReadonlyArray<SkillScope> = ['global', 'local'];
const SCOPE_LABELS: Record<SkillScope, string> = {
  global: 'Global',
  local: 'Local',
};

function isSkillIndex(node: SkillNode): boolean {
  // Case-sensitive — that's how the manifest stores it and how
  // `condash skills install` reasons about file identity.
  return node.kind === 'file' && node.name === 'SKILL.md';
}

function isYamlSpec(node: SkillNode): boolean {
  if (node.kind !== 'file') return false;
  const lower = node.name.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

/** Strip the `__sentinel__/` prefix off an injected agent-config relPath for
 *  display (`__claude__/.claude/CLAUDE.md` → `.claude/CLAUDE.md`). */
function configMeta(relPath: string): string {
  return relPath.replace(/^__[^/]+__\//, '');
}

export function SkillsView(props: {
  scope: SkillScope;
  onSelectScope: (scope: SkillScope) => void;
  /** Reload the active (scope, tab) tree. */
  onRefresh: () => void;
  tab: SkillTab;
  onSelectTab: (tab: SkillTab) => void;
  root: SkillNode | null;
  onOpen: (path: string, title: string, shipped?: SkillNode['shipped']) => void;
  /** Open Settings (so the user can adjust `skills_path`). */
  onOpenSettings?: () => void;
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
  // Per-tab scroll memory so flipping tabs restores the prior position.
  const scrollRef = usePaneScrollMemory(() => `skills-${props.scope}-${props.tab}`);

  // Memoise pane-level callbacks so prop identity stays stable across
  // unrelated parent re-runs (e.g. expanding one directory). Tracks
  // `props.tab` so the special-file predicate updates when the user
  // switches tab, but is otherwise a stable reference. See
  // notes/01-design.md.
  // The injected agent-config entries (badge != null) are lifted out of the
  // tree into their own band above it — there can be several (the Generic
  // common.md + <model>.md sources; two CLAUDE.md candidates), and TreeView
  // only ever promotes one special file per directory. Everything else
  // (real skills + their SKILL.md) flows through TreeView unchanged.
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

  // The only special file TreeView still promotes is a sub-skill dir's
  // SKILL.md (not on the Generic tab, never at the root).
  const specialFile = createMemo(() => {
    const tab = props.tab;
    return (file: SkillNode, dir: SkillNode): boolean =>
      tab !== 'generic' && dir.relPath !== '' && isSkillIndex(file);
  });
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
    <SkillCard
      node={file}
      isYaml={isYamlSpec(file)}
      onOpen={() => props.onOpen(file.path, file.title, file.shipped)}
    />
  ));

  // Per-tab button refs so the ARIA keyboard handler below can move focus
  // to the next/previous tab without a global DOM query.
  const tabRefs: Partial<Record<SkillTab, HTMLButtonElement>> = {};

  // ARIA tab pattern: Left/Right (and Home/End) cycle the tab strip when
  // a tab button has focus. We focus the next tab so screen readers
  // re-announce and the visible focus ring follows. Wraps end-to-end.
  const handleTabKeyDown = (event: KeyboardEvent, tab: SkillTab): void => {
    const current = SKILL_TABS.indexOf(tab);
    if (current < 0) return;
    let nextIndex: number;
    if (event.key === 'ArrowLeft') {
      nextIndex = (current - 1 + SKILL_TABS.length) % SKILL_TABS.length;
    } else if (event.key === 'ArrowRight') {
      nextIndex = (current + 1) % SKILL_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SKILL_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = SKILL_TABS[nextIndex];
    props.onSelectTab(nextTab);
    tabRefs[nextTab]?.focus();
  };

  const emptyState = () => {
    if (props.tab === 'generic') {
      return (
        <div class="empty">
          <p>No source skills.</p>
          <p>
            Run <code>condash skills install</code> to lay down bundled skillspecs under{' '}
            <code>.agents/skills/</code>.
          </p>
          <div class="empty-actions">
            <Show when={props.onCopyInstallCommand}>
              <button
                type="button"
                class="empty-cta"
                onClick={() => props.onCopyInstallCommand?.()}
              >
                Copy install command
              </button>
            </Show>
          </div>
        </div>
      );
    }
    if (props.tab === 'kimi') {
      return (
        <div class="empty">
          <p>No Kimi skills installed.</p>
          <p>
            Run <code>condash skills install</code> to compile bundled skills for Kimi under{' '}
            <code>.kimi/skills/</code>.
          </p>
          <div class="empty-actions">
            <Show when={props.onCopyInstallCommand}>
              <button
                type="button"
                class="empty-cta"
                onClick={() => props.onCopyInstallCommand?.()}
              >
                Copy install command
              </button>
            </Show>
          </div>
        </div>
      );
    }
    if (props.tab === 'opencode') {
      return (
        <div class="empty">
          <p>No OpenCode skills installed.</p>
          <p>
            Run <code>condash skills install</code> to compile bundled skills for OpenCode under{' '}
            <code>.opencode/skills/</code>.
          </p>
          <div class="empty-actions">
            <Show when={props.onCopyInstallCommand}>
              <button
                type="button"
                class="empty-cta"
                onClick={() => props.onCopyInstallCommand?.()}
              >
                Copy install command
              </button>
            </Show>
          </div>
        </div>
      );
    }
    return (
      <div class="empty">
        <p>No skills installed.</p>
        <p>
          Run <code>condash skills install</code> to lay down the bundled skills, or change{' '}
          <code>skills_path</code> in Settings.
        </p>
        <div class="empty-actions">
          <Show when={props.onCopyInstallCommand}>
            <button type="button" class="empty-cta" onClick={() => props.onCopyInstallCommand?.()}>
              Copy install command
            </button>
          </Show>
          <Show when={props.onOpenSettings}>
            <button type="button" class="empty-cta" onClick={() => props.onOpenSettings?.()}>
              Edit settings
            </button>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <div class="skills-pane">
      <div class="skills-scope-row">
        <div class="skills-scope" role="group" aria-label="Skill scope">
          <For each={SCOPE_ORDER}>
            {(scope) => (
              <button
                type="button"
                class="skills-scope-btn"
                classList={{ active: props.scope === scope }}
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
      <div class="skills-tabs" role="tablist" aria-label="Skill tree source">
        <For each={SKILL_TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              class="skills-tab"
              classList={{ active: props.tab === tab }}
              aria-selected={props.tab === tab}
              tabIndex={props.tab === tab ? 0 : -1}
              ref={(el) => {
                tabRefs[tab] = el;
              }}
              onClick={() => props.onSelectTab(tab)}
              onKeyDown={(e) => handleTabKeyDown(e, tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          )}
        </For>
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

function SkillCard(props: { node: SkillNode; isYaml: boolean; onOpen: () => void }) {
  const shippedStatus = (): 'none' | 'clean' | 'diverged' => {
    const s = props.node.shipped;
    if (!s) return 'none';
    return s.diverged ? 'diverged' : 'clean';
  };

  return (
    <article
      class="skills-card"
      data-shipped={shippedStatus()}
      data-kind={props.isYaml ? 'yaml' : 'md'}
      title={props.node.path}
      tabIndex={0}
      role="button"
      aria-label={`Open ${props.isYaml ? 'spec' : 'skill'} ${props.node.title}`}
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
        <Show when={props.isYaml}>
          <span class="skills-card-kind">YAML</span>
        </Show>
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
