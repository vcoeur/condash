/**
 * Appearance + Terminal sections of the Settings modal. Both are personal
 * (per-machine) settings — they live in the global `settings.json` and render
 * once, under the Personal group.
 */

import { type JSX } from 'solid-js';
import type {
  ActionTemplate,
  CardMinWidthPrefs,
  Platform,
  TerminalLoggingPrefs,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import { type BindTextFn, type ColorEntry, type TerminalStringFieldKey } from './data';
import { CardDensityFields, TerminalFields, ThemePicker } from './fields';
import { SectionShell } from './section-shell';

interface AppearanceSectionProps {
  theme: () => Theme;
  setTheme: (theme: Theme) => Promise<void>;
  cardMinWidth: (key: keyof CardMinWidthPrefs) => number;
  setCardMinWidth: (patch: CardMinWidthPrefs) => Promise<void>;
}

export function AppearanceSection(props: AppearanceSectionProps): JSX.Element {
  return (
    <SectionShell
      id="appearance"
      title="Appearance"
      scope="global"
      hint={
        <p class="settings-section-hint">
          Theme and card density for this machine. Each grid keeps a row of <em>n</em> cards until
          the pane is wide enough to fit <em>n+1</em> at this width, then reflows.
        </p>
      }
    >
      <ThemePicker current={props.theme()} onChange={(t) => void props.setTheme(t)} />
      <CardDensityFields
        resolve={props.cardMinWidth}
        onChange={(patch) => void props.setCardMinWidth(patch)}
      />
    </SectionShell>
  );
}

interface TerminalSectionProps {
  bindText: BindTextFn;
  prefs: () => TerminalPrefs;
  xterm: () => TerminalXtermPrefs;
  setString: (key: TerminalStringFieldKey, value: string) => Promise<void>;
  projectActions: () => ActionTemplate[];
  patchProjectAction: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  addProjectAction: () => Promise<void>;
  removeProjectAction: (index: number) => Promise<void>;
  moveProjectAction: (index: number, delta: -1 | 1) => Promise<void>;
  newProjectActions: () => ActionTemplate[];
  patchNewProjectAction: (index: number, patch: Partial<ActionTemplate>) => Promise<void>;
  addNewProjectAction: () => Promise<void>;
  removeNewProjectAction: (index: number) => Promise<void>;
  moveNewProjectAction: (index: number, delta: -1 | 1) => Promise<void>;
  updateXterm: (patch: Partial<TerminalXtermPrefs>) => Promise<void>;
  updateColor: (key: ColorEntry['key'], value: string) => void;
  updateLogging: (patch: Partial<TerminalLoggingPrefs>) => Promise<void>;
  setAutoRefreshOnTabSwitch: (value: boolean) => Promise<void>;
  platform: () => Platform | undefined;
}

export function TerminalSection(props: TerminalSectionProps): JSX.Element {
  return (
    <SectionShell
      id="terminal"
      title="Terminal"
      scope="global"
      hint={
        <p class="settings-section-hint">
          Shell, shortcuts, font and colours, on-disk session logging, and project-action shortcuts
          — all per-machine.
        </p>
      }
    >
      <TerminalFields
        target="global"
        bindText={props.bindText}
        prefs={props.prefs}
        xterm={props.xterm}
        setString={props.setString}
        projectActions={props.projectActions}
        patchProjectAction={props.patchProjectAction}
        addProjectAction={props.addProjectAction}
        removeProjectAction={props.removeProjectAction}
        moveProjectAction={props.moveProjectAction}
        newProjectActions={props.newProjectActions}
        patchNewProjectAction={props.patchNewProjectAction}
        addNewProjectAction={props.addNewProjectAction}
        removeNewProjectAction={props.removeNewProjectAction}
        moveNewProjectAction={props.moveNewProjectAction}
        updateXterm={props.updateXterm}
        updateColor={props.updateColor}
        updateLogging={props.updateLogging}
        setAutoRefreshOnTabSwitch={props.setAutoRefreshOnTabSwitch}
        platform={props.platform}
      />
    </SectionShell>
  );
}
