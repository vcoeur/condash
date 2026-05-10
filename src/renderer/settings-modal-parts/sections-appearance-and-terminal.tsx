/**
 * Appearance + Terminal sections of the Settings modal.
 *
 * Both sections are inheritable — the same UI ships on the Global tab
 * (writes to settings.json) and the Conception tab (writes to
 * condash.json). Each component is parameterised on `target` and
 * rendered twice in the modal. Inheritance badges + the Remove-override
 * button only render on the conception side; the section keys those off
 * the presence of `stateOf` / `removeOverride` props.
 */

import { Show, type JSX } from 'solid-js';
import type {
  CardMinWidthPrefs,
  Platform,
  TerminalPrefs,
  TerminalXtermPrefs,
  Theme,
} from '@shared/types';
import {
  type BindTextFn,
  type ColorEntry,
  type SettingsTab,
  type TerminalStringFieldKey,
} from './data';
import { CardDensityFields, TerminalFields, ThemePicker } from './fields';
import { FieldBadgeRow, type InheritanceState } from './badges';

/**
 * Optional inheritance-badge inputs. Pass these from the conception side;
 * omit on the global side.
 */
interface BadgeProps {
  stateOf?: () => InheritanceState;
  removeOverride?: () => void;
}

interface AppearanceSectionProps {
  target: SettingsTab;
  themeFor: (target: SettingsTab) => Theme;
  setTheme: (theme: Theme) => Promise<void>;
  cardMinWidthFor: (target: SettingsTab) => (key: keyof CardMinWidthPrefs) => number;
  setCardMinWidth: (patch: CardMinWidthPrefs) => Promise<void>;
  /** Inheritance state for the `theme` key. Conception tab only. */
  themeBadge?: BadgeProps;
  /** Inheritance state for the `cardMinWidth` key. Conception tab only. */
  cardMinWidthBadge?: BadgeProps;
}

export function AppearanceSection(props: AppearanceSectionProps): JSX.Element {
  const isConception = (): boolean => props.target === 'conception';
  return (
    <section id={`settings-section-appearance:${props.target}`} class="settings-section">
      <Show
        when={isConception()}
        fallback={
          <>
            <h2>Appearance</h2>
            <p class="settings-section-hint">
              Per-machine defaults. Each conception can override these in its own{' '}
              <code>condash.json</code>.
            </p>
            <ThemePicker
              current={props.themeFor(props.target)}
              onChange={(t) => void props.setTheme(t)}
            />
            <CardDensityFields
              resolve={props.cardMinWidthFor(props.target)}
              onChange={(patch) => void props.setCardMinWidth(patch)}
            />
          </>
        }
      >
        <div class="settings-section-head">
          <h2>Appearance</h2>
        </div>
        <div class="settings-section-subhead">
          <h3>Theme</h3>
          <Show when={props.themeBadge}>
            {(badge) => (
              <FieldBadgeRow
                state={badge().stateOf?.() ?? 'inherits'}
                onRemove={() => badge().removeOverride?.()}
              />
            )}
          </Show>
        </div>
        <ThemePicker
          current={props.themeFor(props.target)}
          onChange={(t) => void props.setTheme(t)}
        />
        <div class="settings-section-subhead">
          <h3>Card density</h3>
          <Show when={props.cardMinWidthBadge}>
            {(badge) => (
              <FieldBadgeRow
                state={badge().stateOf?.() ?? 'inherits'}
                onRemove={() => badge().removeOverride?.()}
              />
            )}
          </Show>
        </div>
        <p class="settings-hint">
          Each grid keeps a row of <em>n</em> cards until the pane is wide enough to fit{' '}
          <em>n+1</em> cards each at this width — at which point the row reflows.
        </p>
        <CardDensityFields
          resolve={props.cardMinWidthFor(props.target)}
          onChange={(patch) => void props.setCardMinWidth(patch)}
        />
      </Show>
    </section>
  );
}

interface TerminalSectionProps {
  target: SettingsTab;
  bindText: BindTextFn;
  prefs: () => TerminalPrefs;
  xterm: () => TerminalXtermPrefs;
  setString: (key: TerminalStringFieldKey, value: string) => Promise<void>;
  updateXterm: (patch: Partial<TerminalXtermPrefs>) => Promise<void>;
  updateColor: (key: ColorEntry['key'], value: string) => void;
  platform: () => Platform | undefined;
  /** Inheritance state for the `terminal` key. Conception tab only. */
  badge?: BadgeProps;
}

export function TerminalSection(props: TerminalSectionProps): JSX.Element {
  const isConception = (): boolean => props.target === 'conception';
  return (
    <section id={`settings-section-terminal:${props.target}`} class="settings-section">
      <Show
        when={isConception()}
        fallback={
          <>
            <h2>Terminal</h2>
            <p class="settings-section-hint">
              Per-machine defaults. Each conception can override the entire <code>terminal</code>{' '}
              block in its <code>condash.json</code>.
            </p>
          </>
        }
      >
        <div class="settings-section-head">
          <h2>Terminal</h2>
          <Show when={props.badge}>
            {(badge) => (
              <FieldBadgeRow
                state={badge().stateOf?.() ?? 'inherits'}
                onRemove={() => badge().removeOverride?.()}
              />
            )}
          </Show>
        </div>
        <p class="settings-section-hint">
          Override the entire <code>terminal</code> block for this conception. Editing any field
          here writes the whole block to <code>condash.json</code>.
        </p>
      </Show>
      <TerminalFields
        target={props.target}
        bindText={props.bindText}
        prefs={props.prefs}
        xterm={props.xterm}
        setString={props.setString}
        updateXterm={props.updateXterm}
        updateColor={props.updateColor}
        platform={props.platform}
      />
    </section>
  );
}
