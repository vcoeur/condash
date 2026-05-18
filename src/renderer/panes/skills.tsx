import { createMemo, For, Show } from 'solid-js';
import type { SkillNode, SkillTab } from '@shared/types';
import { SKILL_TABS } from '@shared/types';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './skills-pane.css';

// Compiled tabs (Claude / Kimi) accept the same SKILL_AFFORDANCES as before;
// the Generic tab also accepts source-edit mutations. The Kimi tab is
// read-only because its content is regenerated on every `condash skills
// install` — see notes/02-design.md §Q1.
//
// Each compiled tab also surfaces the conception's agent-config file as a
// synthetic root-level entry: CLAUDE.md on the Claude tab, AGENTS.md on
// the Kimi tab (injected in src/main/skills.ts).
const EDITABLE_AFFORDANCES: ReadonlyArray<TreeAffordance> = ['createMd', 'mkdir'];
const READONLY_AFFORDANCES: ReadonlyArray<TreeAffordance> = [];

const TAB_LABELS: Record<SkillTab, string> = {
  generic: 'Generic',
  claude: 'Claude',
  kimi: 'Kimi',
};

function isSkillIndex(node: SkillNode): boolean {
  // Case-sensitive — that's how the manifest stores it and how
  // `condash skills install` reasons about file identity.
  return node.kind === 'file' && node.name === 'SKILL.md';
}

/** Recognise a synthetic CLAUDE.md entry injected by the main-process
 *  skills walker. Carries `name === 'CLAUDE.md'` and lives only at the
 *  skills root (`relPath` starts with the `__claude__/` sentinel). */
function isClaudeMd(node: SkillNode): boolean {
  return node.kind === 'file' && node.name === 'CLAUDE.md';
}

/** Recognise a synthetic AGENTS.md entry injected by the main-process
 *  skills walker for the Kimi tab. Carries `name === 'AGENTS.md'` and
 *  lives only at the skills root (`relPath` starts with the `__kimi__/`
 *  sentinel). */
function isAgentsMd(node: SkillNode): boolean {
  return node.kind === 'file' && node.name === 'AGENTS.md';
}

function isYamlSpec(node: SkillNode): boolean {
  if (node.kind !== 'file') return false;
  const lower = node.name.toLowerCase();
  return lower.endsWith('.yaml') || lower.endsWith('.yml');
}

export function SkillsView(props: {
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
  const scrollRef = usePaneScrollMemory(() => `skills-${props.tab}`);

  const affordances = (): ReadonlyArray<TreeAffordance> =>
    props.tab === 'kimi' ? READONLY_AFFORDANCES : EDITABLE_AFFORDANCES;

  // Memoise pane-level callbacks so prop identity stays stable across
  // unrelated parent re-runs (e.g. expanding one directory). Tracks
  // `props.tab` so the special-file predicate updates when the user
  // switches tab, but is otherwise a stable reference. See
  // notes/01-design.md.
  const specialFile = createMemo(() => {
    const tab = props.tab;
    return (file: SkillNode, dir: SkillNode): boolean => {
      if (dir.relPath === '' && tab === 'claude' && isClaudeMd(file)) return true;
      if (dir.relPath === '' && tab === 'kimi' && isAgentsMd(file)) return true;
      if (tab !== 'generic' && dir.relPath !== '' && isSkillIndex(file)) return true;
      return false;
    };
  });
  const renderSpecialFile = createMemo(() => (file: SkillNode, dir: SkillNode) => {
    if (isClaudeMd(file) || isAgentsMd(file)) {
      const badge = isClaudeMd(file) ? 'CLAUDE' : 'AGENTS';
      return (
        <button
          type="button"
          class="tree-special-file claude-special-file"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen(file.path, file.title, file.shipped);
          }}
          title={`Open ${file.path}`}
          aria-label={`Open ${file.path}`}
        >
          <span class="tree-special-badge">{badge}</span>
          <span class="tree-special-title">{file.title}</span>
          <span class="tree-special-meta">{file.relPath}</span>
        </button>
      );
    }
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
          {(root) => (
            <TreeView<SkillNode>
              treeKey="skills"
              root={root()}
              expanded={props.expanded}
              onToggleExpand={props.onToggleExpand}
              affordances={affordances()}
              mutations={props.mutations}
              prompts={props.prompts}
              onAfterMutation={props.onAfterMutation}
              onError={props.onError}
              specialFile={specialFile()}
              renderSpecialFile={renderSpecialFile()}
              renderFile={renderFile()}
            />
          )}
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
