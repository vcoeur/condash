import { Show } from 'solid-js';
import type { SkillNode } from '@shared/types';
import { usePaneScrollMemory } from './pane-scroll-memory';
import {
  TreeView,
  type TreeAffordance,
  type TreeViewMutationApi,
  type TreeViewPromptApi,
} from './tree-view';
import './skills-pane.css';

const SKILLS_AFFORDANCES: ReadonlyArray<TreeAffordance> = ['createMd', 'mkdir'];

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

export function SkillsView(props: {
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
  const scrollRef = usePaneScrollMemory('skills');

  return (
    <div class="skills-pane" ref={scrollRef}>
      <Show
        when={props.root}
        fallback={
          <div class="empty">
            <p>No skills installed.</p>
            <p>
              Run <code>condash skills install</code> to lay down the bundled skills, or change{' '}
              <code>skills_path</code> in Settings.
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
              <Show when={props.onOpenSettings}>
                <button type="button" class="empty-cta" onClick={() => props.onOpenSettings?.()}>
                  Edit settings
                </button>
              </Show>
            </div>
          </div>
        }
      >
        {(root) => (
          <TreeView<SkillNode>
            treeKey="skills"
            root={root()}
            expanded={props.expanded}
            onToggleExpand={props.onToggleExpand}
            affordances={SKILLS_AFFORDANCES}
            mutations={props.mutations}
            prompts={props.prompts}
            onAfterMutation={props.onAfterMutation}
            onError={props.onError}
            specialFile={(file, dir) => {
              // Sub-directories surface their SKILL.md; the synthetic
              // CLAUDE.md entries surface only at the root level.
              if (dir.relPath === '') return isClaudeMd(file);
              return isSkillIndex(file);
            }}
            renderSpecialFile={(file, dir) => {
              if (isClaudeMd(file)) {
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
                    <span class="tree-special-badge">CLAUDE</span>
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
                    <span class="tree-special-meta">
                      {shipped?.diverged ? 'diverged' : 'shipped'}
                    </span>
                  </Show>
                </button>
              );
            }}
            renderFile={(file) => (
              <SkillCard
                node={file}
                onOpen={() => props.onOpen(file.path, file.title, file.shipped)}
              />
            )}
          />
        )}
      </Show>
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
