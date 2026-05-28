/**
 * Workspace section of the Settings modal — conception tab only.
 *
 * Two FieldWithBadge inputs over the two conception-side path keys:
 * `workspace_path`, `worktrees_path`. The Resources pane (always
 * `<root>/resources/`) and the Skills pane (always `<root>/.agents/skills/`)
 * are hard-coded post-reframe — no override rows for either.
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
import { FieldWithBadge } from './fields';
import type { InheritanceState } from './badges';

interface WorkspaceSectionProps {
  bindText: BindTextFn;
  parsed: () => RawConfig;
  stateOf: <K extends keyof RawConfig>(key: K) => InheritanceState;
  removeOverride: <K extends keyof RawConfig>(key: K) => Promise<void>;
  patchConfig: (mutator: (config: RawConfig) => void) => Promise<void>;
  platform: () => Platform | undefined;
}

export function WorkspaceSection(props: WorkspaceSectionProps): JSX.Element {
  const setWorkspacePath = (value: string): Promise<void> =>
    props.patchConfig((c) => {
      c.workspace_path = value || undefined;
    });

  const setWorktreesPath = (value: string): Promise<void> =>
    props.patchConfig((c) => {
      c.worktrees_path = value || undefined;
    });

  return (
    <section id="settings-section-workspace:conception" class="settings-section">
      <div class="settings-section-head">
        <h2>Workspace</h2>
      </div>
      <div class="settings-grid settings-grid--wide">
        <FieldWithBadge
          label="Workspace path"
          pathScope="abs"
          state={props.stateOf('workspace_path')}
          onRemove={() => void props.removeOverride('workspace_path')}
        >
          <input
            type="text"
            placeholder={pick(WORKSPACE_PLACEHOLDER, props.platform())}
            {...props.bindText(
              'conception.workspace_path',
              () => props.parsed().workspace_path,
              setWorkspacePath,
            )}
          />
        </FieldWithBadge>
        <FieldWithBadge
          label="Worktrees path"
          pathScope="abs"
          state={props.stateOf('worktrees_path')}
          onRemove={() => void props.removeOverride('worktrees_path')}
        >
          <input
            type="text"
            placeholder={pick(WORKTREES_PLACEHOLDER, props.platform())}
            {...props.bindText(
              'conception.worktrees_path',
              () => props.parsed().worktrees_path,
              setWorktreesPath,
            )}
          />
        </FieldWithBadge>
      </div>
    </section>
  );
}
