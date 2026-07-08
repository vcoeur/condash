/**
 * Workspace section of the Settings modal — a per-conception setting (writes
 * `.condash/settings.json`). Two path inputs over `workspace_path` and
 * `worktrees_path`, plus a list editor for `long_lived_branches`. The Resources
 * pane (always `<root>/resources/`) and the Skills pane (always
 * `<root>/.agents/skills/`) are hard-coded post-reframe.
 */

import { For, type JSX } from 'solid-js';
import type { Platform } from '@shared/types';
import {
  type BindTextFn,
  type RawConfig,
  WORKSPACE_PLACEHOLDER,
  WORKTREES_PLACEHOLDER,
  pick,
} from './data';
import { LabeledField } from './fields';
import { SectionShell } from './section-shell';
import { Button } from '../actions';

interface WorkspaceSectionProps {
  bindText: BindTextFn;
  parsed: () => RawConfig;
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
  platform: () => Platform | undefined;
}

export function WorkspaceSection(props: WorkspaceSectionProps): JSX.Element {
  const setWorkspacePath = (value: string): Promise<void> =>
    props.patch((c) => {
      c.workspace_path = value || undefined;
    });

  const setWorktreesPath = (value: string): Promise<void> =>
    props.patch((c) => {
      c.worktrees_path = value || undefined;
    });

  const branches = (): string[] => props.parsed().long_lived_branches ?? [];

  const updateBranches = (mutate: (entries: string[]) => string[]): Promise<void> =>
    props.patch((c) => {
      const next = mutate((c.long_lived_branches ?? []).slice());
      c.long_lived_branches = next.length > 0 ? next : undefined;
    });

  const addBranch = (): Promise<void> => updateBranches((entries) => [...entries, '']);

  const removeBranch = (index: number): Promise<void> =>
    updateBranches((entries) => entries.filter((_, i) => i !== index));

  const setBranch = (index: number, value: string): Promise<void> =>
    updateBranches((entries) => entries.map((entry, i) => (i === index ? value : entry)));

  return (
    <SectionShell
      id="workspace"
      title="Workspace & paths"
      scope="conception"
      hint={
        <p class="settings-section-hint">
          Where this conception's repositories and worktrees live on this machine.
        </p>
      }
    >
      <div class="settings-grid settings-grid--wide">
        <LabeledField label="Workspace path" pathScope="abs">
          <input
            type="text"
            placeholder={pick(WORKSPACE_PLACEHOLDER, props.platform())}
            {...props.bindText(
              'conception.workspace_path',
              () => props.parsed().workspace_path,
              setWorkspacePath,
            )}
          />
        </LabeledField>
        <LabeledField label="Worktrees path" pathScope="abs">
          <input
            type="text"
            placeholder={pick(WORKTREES_PLACEHOLDER, props.platform())}
            {...props.bindText(
              'conception.worktrees_path',
              () => props.parsed().worktrees_path,
              setWorktreesPath,
            )}
          />
        </LabeledField>
      </div>
      <div class="settings-bucket">
        <LabeledField
          label="Protected branch patterns"
          hint={
            'These branches are protected from condash worktrees remove and are never auto-deleted. ' +
            'Glob wildcards are supported: * matches any run of characters and ? matches one character ' +
            '(e.g. release/*, hotfix-?). When the list is empty, the runtime falls back to the default ' +
            'main + master, so leaving it empty does not disable protection. A non-empty list replaces ' +
            'that default rather than extending it — keep main and master here if you still want them protected.'
          }
        >
          <For each={branches()}>
            {(entry, index) => (
              <div class="settings-list-row">
                <input
                  type="text"
                  placeholder="release/*"
                  aria-label={`Branch pattern ${index() + 1}`}
                  {...props.bindText(
                    `conception.long_lived_branches[${index()}]`,
                    () => entry,
                    (v) => setBranch(index(), v),
                  )}
                />
                <Button
                  variant="default"
                  class="btn--modal-head"
                  title="Remove branch"
                  aria-label="Remove branch"
                  onClick={() => void removeBranch(index())}
                >
                  ×
                </Button>
              </div>
            )}
          </For>
          <div class="settings-list-actions">
            <Button variant="default" onClick={() => void addBranch()}>
              + Add branch
            </Button>
          </div>
        </LabeledField>
      </div>
    </SectionShell>
  );
}
