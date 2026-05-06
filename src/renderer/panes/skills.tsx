import { createMemo, For, Show } from 'solid-js';
import type { SkillNode } from '@shared/types';
import { filterByQuery } from '../filter-by-query';
import './skills-pane.css';

interface SkillSection {
  /** Path relative to the skills root, e.g. "projects" or "projects/subdir". */
  id: string;
  label: string;
  /** SKILL.md when this directory is a skill — surfaced as the section index. */
  index?: SkillNode;
  /** Other `.md` body files in this directory. */
  files: SkillNode[];
}

/**
 * Walk the skills tree and emit one section per directory at any depth
 * that contains at least one `.md`. `SKILL.md` (case-sensitive — that is
 * how the manifest stores it) is pulled out of the file list and rendered
 * as a `[SKILL]` index badge on the section header.
 */
function buildSections(root: SkillNode | null): SkillSection[] {
  if (!root) return [];
  const out: SkillSection[] = [];

  const visit = (node: SkillNode, dirRel: string): void => {
    if (node.kind !== 'directory') return;
    const fileChildren: SkillNode[] = [];
    const dirChildren: SkillNode[] = [];
    for (const child of node.children ?? []) {
      if (child.kind === 'directory') dirChildren.push(child);
      else fileChildren.push(child);
    }

    let index: SkillNode | undefined;
    const others: SkillNode[] = [];
    for (const f of fileChildren) {
      if (f.name === 'SKILL.md') index = f;
      else others.push(f);
    }

    if (index || others.length > 0) {
      const label = dirRel === '' ? 'ROOT' : dirRel.split('/').join(' · ').toUpperCase();
      out.push({
        id: dirRel,
        label,
        index,
        files: others.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    for (const sub of dirChildren) {
      const childRel = dirRel ? `${dirRel}/${sub.name}` : sub.name;
      visit(sub, childRel);
    }
  };
  visit(root, '');

  out.sort((a, b) => {
    if (a.id === '') return -1;
    if (b.id === '') return 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

const filterFiles = (files: SkillNode[], q: string): SkillNode[] => filterByQuery(files, q);

function indexMatches(index: SkillNode | undefined, q: string): boolean {
  if (q.trim().length === 0) return true;
  if (!index) return false;
  const lower = q.toLowerCase();
  return index.title.toLowerCase().includes(lower) || index.relPath.toLowerCase().includes(lower);
}

export function SkillsView(props: {
  root: SkillNode | null;
  searchInput: string;
  onOpen: (path: string, title: string, shipped?: SkillNode['shipped']) => void;
}) {
  const sections = createMemo<SkillSection[]>(() => buildSections(props.root));
  const filteredSections = createMemo<SkillSection[]>(() => {
    const q = props.searchInput;
    if (q.trim().length === 0) return sections();
    return sections()
      .map((s) => {
        const files = filterFiles(s.files, q);
        const indexHit = indexMatches(s.index, q);
        if (files.length === 0 && !indexHit) {
          return { ...s, files, index: undefined };
        }
        return { ...s, files, index: indexHit ? s.index : undefined };
      })
      .filter((s) => s.files.length > 0 || s.index);
  });

  return (
    <div class="skills-pane">
      <Show
        when={filteredSections().length > 0}
        fallback={
          <div class="empty">
            <Show
              when={props.searchInput.trim().length > 0}
              fallback={
                <p>
                  No skills directory yet — install skills with <code>condash skills install</code>,
                  or change <code>skills_path</code> in settings.
                </p>
              }
            >
              <p>No matches.</p>
            </Show>
          </div>
        }
      >
        <For each={filteredSections()}>
          {(section) => (
            <section class="skills-group">
              <h2 class="skills-section-header">
                <span class="name">{section.label}</span>
                <Show when={section.files.length > 0}>
                  <span class="count">{section.files.length}</span>
                </Show>
                <Show when={section.index}>
                  {(idx) => (
                    <button
                      type="button"
                      class="skills-section-index"
                      classList={{
                        shipped: !!idx().shipped,
                        diverged: !!idx().shipped?.diverged,
                      }}
                      onClick={() => props.onOpen(idx().path, idx().title, idx().shipped)}
                      aria-label={`Open SKILL.md for ${section.label}${
                        idx().shipped?.diverged
                          ? ' (shipped, locally edited)'
                          : idx().shipped
                            ? ' (shipped)'
                            : ''
                      }`}
                      title={
                        idx().shipped?.diverged
                          ? 'SKILL.md (shipped, locally edited)'
                          : idx().shipped
                            ? 'SKILL.md (shipped)'
                            : 'SKILL.md'
                      }
                    >
                      SKILL
                      <Show when={idx().shipped}>
                        <span class="shipped-tag">
                          {idx().shipped?.diverged ? ' · diverged' : ' · shipped'}
                        </span>
                      </Show>
                    </button>
                  )}
                </Show>
                <span class="rule" />
              </h2>
              <Show when={section.files.length > 0}>
                <div class="skills-grid">
                  <For each={section.files}>
                    {(file) => (
                      <SkillCard
                        node={file}
                        onOpen={() => props.onOpen(file.path, file.title, file.shipped)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </section>
          )}
        </For>
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
