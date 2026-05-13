/**
 * Repositories + Open-with sections of the Settings modal — conception
 * tab only. Both render lists driven by closures from the modal shell.
 * Each section owns its own list-mutation helpers (add / remove / move /
 * patch entry) — pure `patchConfig` wrappers, no state shared with the
 * modal shell.
 */

import { For, Show, type JSX } from 'solid-js';
import { isSectionMarker, type RawRepo } from '../../main/config-schema';
import { type BindTextFn, OPEN_WITH_SLOTS, type RawConfig } from './data';
import { FieldBadgeRow, type InheritanceState } from './badges';
import { RepoRow } from './repo-row';
import { SectionRow } from './section-row';

interface RepositoriesSectionProps {
  parsed: () => RawConfig;
  bindText: BindTextFn;
  stateOf: <K extends keyof RawConfig>(key: K) => InheritanceState;
  removeOverride: <K extends keyof RawConfig>(key: K) => Promise<void>;
  patchConfig: (mutator: (config: RawConfig) => void) => Promise<void>;
}

export function RepositoriesSection(props: RepositoriesSectionProps): JSX.Element {
  const repos = (): RawRepo[] => props.parsed().repositories ?? [];

  const updateRepos = (mutate: (entries: RawRepo[]) => RawRepo[]): Promise<void> =>
    props.patchConfig((c) => {
      const current = (c.repositories ?? []).slice();
      c.repositories = mutate(current);
    });

  const addRepo = (): Promise<void> => updateRepos((entries) => [...entries, { name: '' }]);

  const addSection = (): Promise<void> =>
    updateRepos((entries) => [...entries, { section: 'New section' }]);

  const removeRepo = (index: number): Promise<void> =>
    updateRepos((entries) => entries.filter((_, i) => i !== index));

  const moveRepo = (index: number, delta: -1 | 1): Promise<void> =>
    updateRepos((entries) => {
      const target = index + delta;
      if (target < 0 || target >= entries.length) return entries;
      const next = entries.slice();
      const [removed] = next.splice(index, 1);
      next.splice(target, 0, removed);
      return next;
    });

  const updateRepoEntry = (index: number, patch: (entry: RawRepo) => RawRepo): Promise<void> =>
    updateRepos((entries) => entries.map((e, i) => (i === index ? patch(e) : e)));

  return (
    <section id="settings-section-repositories:conception" class="settings-section">
      <div class="settings-section-head">
        <h2>Repositories</h2>
        <FieldBadgeRow
          state={props.stateOf('repositories')}
          onRemove={() => void props.removeOverride('repositories')}
        />
      </div>
      <p class="settings-hint">
        Each entry is either just a name (resolved against <code>workspace_path</code>) or an object
        with optional <code>label</code>, <code>run</code>, <code>force_stop</code>,{' '}
        <code>install</code>, <code>env</code>, and <code>submodules</code>. A{' '}
        <code>{'{ "section": "…" }'}</code> entry inserts a header above the repos that follow it,
        in this list and in the Code pane.
      </p>
      <div class="settings-bucket">
        <For each={repos()}>
          {(entry, index) => (
            <Show
              when={!isSectionMarker(entry)}
              fallback={
                <SectionRow
                  entry={entry as { section: string }}
                  idPrefix={`repo[${index()}]`}
                  index={index()}
                  total={repos().length}
                  bindText={props.bindText}
                  onMove={(delta) => void moveRepo(index(), delta)}
                  onRemove={() => void removeRepo(index())}
                  onPatch={(next) => updateRepoEntry(index(), () => next)}
                />
              }
            >
              <RepoRow
                entry={entry as Exclude<RawRepo, { section: string }>}
                idPrefix={`repo[${index()}]`}
                index={index()}
                total={repos().length}
                bindText={props.bindText}
                onMove={(delta) => void moveRepo(index(), delta)}
                onRemove={() => void removeRepo(index())}
                onPatch={(next) => updateRepoEntry(index(), () => next)}
              />
            </Show>
          )}
        </For>
        <div class="settings-list-actions">
          <button class="modal-button" onClick={() => void addRepo()}>
            + Add repo
          </button>
          <button class="modal-button" onClick={() => void addSection()}>
            + Add section
          </button>
        </div>
      </div>
    </section>
  );
}

interface OpenWithSectionProps {
  parsed: () => RawConfig;
  bindText: BindTextFn;
  stateOf: <K extends keyof RawConfig>(key: K) => InheritanceState;
  removeOverride: <K extends keyof RawConfig>(key: K) => Promise<void>;
  patchConfig: (mutator: (config: RawConfig) => void) => Promise<void>;
}

export function OpenWithSection(props: OpenWithSectionProps): JSX.Element {
  const updateOpenWithSlot = (
    key: 'main_ide' | 'secondary_ide' | 'terminal',
    patch: { label?: string; command?: string },
  ): Promise<void> =>
    props.patchConfig((c) => {
      const openWith = (c.open_with ?? {}) as Record<string, { label?: string; command?: string }>;
      const current = openWith[key] ?? {};
      const merged = { ...current, ...patch };
      if (!merged.command) {
        delete openWith[key];
      } else {
        openWith[key] = merged;
      }
      c.open_with = openWith;
    });

  return (
    <section id="settings-section-open-with:conception" class="settings-section">
      <div class="settings-section-head">
        <h2>Open with</h2>
        <FieldBadgeRow
          state={props.stateOf('open_with')}
          onRemove={() => void props.removeOverride('open_with')}
        />
      </div>
      <p class="settings-hint">
        Three slots used by the per-folder &quot;Open in…&quot; menu. <code>{'{path}'}</code> is
        substituted with the absolute path. Clear the command to remove the slot.
      </p>
      <div class="settings-grid settings-grid--wide">
        <For each={OPEN_WITH_SLOTS}>
          {(slot) => {
            const current = (): { label?: string; command?: string } =>
              props.parsed().open_with?.[slot.key] ?? {};
            return (
              <div class="settings-open-with">
                <span class="settings-field-label">{slot.label}</span>
                <input
                  type="text"
                  placeholder={`Open in ${slot.label.toLowerCase()}`}
                  {...props.bindText(
                    `conception.open_with.${slot.key}.label`,
                    () => current().label,
                    (v) => updateOpenWithSlot(slot.key, { label: v }),
                  )}
                />
                <input
                  type="text"
                  placeholder="idea {path}"
                  {...props.bindText(
                    `conception.open_with.${slot.key}.command`,
                    () => current().command,
                    (v) => updateOpenWithSlot(slot.key, { command: v }),
                  )}
                />
              </div>
            );
          }}
        </For>
      </div>
    </section>
  );
}
