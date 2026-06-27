/**
 * Workspace section of the Settings modal — a per-conception setting (writes
 * `.condash/settings.json`). Two path inputs over `workspace_path` and
 * `worktrees_path`. The Resources pane (always `<root>/resources/`) and the
 * Skills pane (always `<root>/.agents/skills/`) are hard-coded post-reframe.
 */

import { type JSX } from 'solid-js';
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
    </SectionShell>
  );
}
