/**
 * Workspace section of the Settings modal — conception tab only.
 *
 * Four FieldWithBadge inputs over the four conception-side path keys:
 * `workspace_path`, `worktrees_path`, `resources_path`, `skills_path`.
 * Each row carries its own inheritance state + Remove-override button.
 * The four path setters live here too — they're pure `patchConfig`
 * wrappers, no state shared with the modal shell.
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

  const setResourcesPath = (value: string): Promise<void> =>
    props.patchConfig((c) => {
      c.resources_path = value || undefined;
    });

  const setSkillsPath = (value: string): Promise<void> =>
    props.patchConfig((c) => {
      c.skills_path = value || undefined;
    });

  return (
    <section id="settings-section-workspace:conception" class="settings-section">
      <div class="settings-section-head">
        <h2>Workspace</h2>
      </div>
      <div class="settings-grid settings-grid--wide">
        <FieldWithBadge
          label="Workspace path"
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
        <FieldWithBadge
          label="Resources directory"
          hint="Relative to the conception root. Browsed by the Resources pane."
          state={props.stateOf('resources_path')}
          onRemove={() => void props.removeOverride('resources_path')}
        >
          <input
            type="text"
            placeholder="resources"
            {...props.bindText(
              'conception.resources_path',
              () => props.parsed().resources_path,
              setResourcesPath,
            )}
          />
        </FieldWithBadge>
        <FieldWithBadge
          label="Skills directory"
          hint="Relative to the conception root. Markdown files here are editable from the Skills pane."
          state={props.stateOf('skills_path')}
          onRemove={() => void props.removeOverride('skills_path')}
        >
          <input
            type="text"
            placeholder=".claude/skills"
            {...props.bindText(
              'conception.skills_path',
              () => props.parsed().skills_path,
              setSkillsPath,
            )}
          />
        </FieldWithBadge>
      </div>
    </section>
  );
}
