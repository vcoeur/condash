import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type {
  ActionTemplate,
  AppScopeMemoryPrefs,
  Platform,
  TerminalLoggingPrefs,
  TerminalMemoryPrefs,
  TerminalPrefs,
  TerminalXtermPrefs,
} from '@shared/types';
import {
  type ColorEntry,
  CURSOR_STYLES,
  pick,
  type SettingsTab,
  TERMINAL_COLORS,
  TERMINAL_STRING_FIELDS,
} from '../data';
import { Subgroup } from './primitives';
import { ActionTemplateSection } from './action-template';
import { ColorField, TerminalColorPreview } from './color';
import { ShortcutCapture } from './shortcut';

/** Terminal section content — string fields, xterm font/cursor/buffer,
 *  colours. Shared between Global and Conception tabs. */
export function TerminalFields(props: {
  target: SettingsTab;
  bindText: (
    id: string,
    persisted: () => string | undefined,
    save: (value: string) => Promise<void>,
  ) => {
    value: string;
    onInput: (e: InputEvent & { currentTarget: HTMLInputElement }) => void;
    onChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
  };
  prefs: () => TerminalPrefs;
  xterm: () => TerminalXtermPrefs;
  setString: (key: (typeof TERMINAL_STRING_FIELDS)[number]['key'], value: string) => Promise<void>;
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
  updateMemory: (patch: Partial<TerminalMemoryPrefs>) => Promise<void>;
  updateAppScopeMemory: (patch: Partial<AppScopeMemoryPrefs>) => Promise<void>;
  setAutoRefreshOnTabSwitch: (value: boolean) => Promise<void>;
  platform: () => Platform | undefined;
}): JSX.Element {
  const logging = (): TerminalLoggingPrefs => props.prefs().logging ?? {};
  // Opt-in: only `true` renders checked (undefined / false → off).
  const autoRefreshOnTabSwitch = (): boolean => props.prefs().autoRefreshOnTabSwitch === true;
  // Opt-in by default: only treat the checkbox as on when the user has
  // explicitly set the flag. `undefined` and `false` both render unchecked.
  const loggingEnabled = (): boolean => logging().enabled === true;
  // Memory containment is the inverse: on by default on capable hosts, so only
  // an explicit `false` renders unchecked. Toggling on prunes to undefined to
  // keep the config minimal (the default already means on).
  const memory = (): TerminalMemoryPrefs => props.prefs().memory ?? {};
  const memoryEnabled = (): boolean => memory().enabled !== false;
  const appScope = (): AppScopeMemoryPrefs => memory().appScope ?? {};
  const appScopeEnabled = (): boolean => appScope().enabled !== false;
  const idPrefix = `${props.target}.terminal`;
  const subgroupId = (suffix: string): string => `${props.target}.terminal.${suffix}`;
  // Static keyword strings drive search matching. Concatenating field
  // labels keeps the index in sync with the rendered content — when a
  // field is renamed, the search behaviour updates with it.
  const behaviourKeywords = TERMINAL_STRING_FIELDS.map((f) => f.label).join(' ');
  return (
    <>
      <Subgroup
        id={subgroupId('behaviour')}
        title="Behaviour & shortcuts"
        keywords={`shell screenshot shortcut keybinding refresh repaint auto tab switch ${behaviourKeywords}`}
        defaultOpen
      >
        <div class="settings-grid">
          <div class="settings-field-span">
            <label class="settings-checkbox">
              <input
                type="checkbox"
                checked={autoRefreshOnTabSwitch()}
                onChange={(e) => void props.setAutoRefreshOnTabSwitch(e.currentTarget.checked)}
              />
              <span>Auto-refresh on tab switch</span>
            </label>
            <small class="settings-field-hint">
              Full-screen TUIs (Claude Code, opencode, Ink, ncurses) already repaint automatically
              on switch — their hydrated snapshot is lossy. Turn this on to also repaint plain
              shells on every switch, i.e. treat every tab like pressing Refresh.
            </small>
          </div>
          <For each={TERMINAL_STRING_FIELDS}>
            {(field) => (
              <label>
                <span class="settings-field-label-row">
                  <span>{field.label}</span>
                  <Show when={field.kind === 'path'}>
                    <span class="settings-path-chip" title="Absolute path">
                      abs
                    </span>
                  </Show>
                </span>
                <Show
                  when={field.kind === 'shortcut'}
                  fallback={
                    <input
                      type="text"
                      placeholder={pick(field.placeholder, props.platform())}
                      {...props.bindText(
                        `${idPrefix}.${field.key}`,
                        () =>
                          (props.prefs() as Record<string, unknown>)[field.key] as
                            | string
                            | undefined,
                        (v) => props.setString(field.key, v),
                      )}
                    />
                  }
                >
                  <ShortcutCapture
                    id={`${idPrefix}.${field.key}`}
                    value={() =>
                      (props.prefs() as Record<string, unknown>)[field.key] as string | undefined
                    }
                    placeholder={pick(field.placeholder, props.platform())}
                    onChange={(v) => void props.setString(field.key, v)}
                  />
                </Show>
                <Show when={field.hint}>
                  <small class="settings-field-hint">{field.hint}</small>
                </Show>
              </label>
            )}
          </For>
        </div>
      </Subgroup>

      <ActionTemplateSection
        title="Project actions"
        subgroupId={subgroupId('project-actions')}
        keywords="project action template agent submit work-on"
        hint="Each entry appears in the dropdown next to the project's Work-on button. Templates accept {slug}, {title}, {branch}, {apps}, … (see Help). Agent (when set) spawns a fresh tab running that agent instead of typing into the focused tab."
        idPrefix={`${idPrefix}.projectActions`}
        bindText={props.bindText}
        items={props.projectActions}
        patch={props.patchProjectAction}
        add={props.addProjectAction}
        remove={props.removeProjectAction}
        move={props.moveProjectAction}
      />

      <ActionTemplateSection
        title="New project actions"
        subgroupId={subgroupId('new-project-actions')}
        keywords="new project action agent template start"
        hint="Each entry appears in the dropdown next to the + New project button. Templates accept {today}, {conception}, {conceptionPath}. Agent (when set) spawns a fresh tab — e.g. bind 'Start new project' to claude-deepseek-v4-pro to get a fresh agent shell on every click."
        idPrefix={`${idPrefix}.newProjectActions`}
        bindText={props.bindText}
        items={props.newProjectActions}
        patch={props.patchNewProjectAction}
        add={props.addNewProjectAction}
        remove={props.removeNewProjectAction}
        move={props.moveNewProjectAction}
      />

      <Subgroup
        id={subgroupId('font')}
        title="Font"
        keywords="font family size line height letter spacing weight bold"
      >
        <div class="settings-grid">
          <label>
            <span>Font family</span>
            <input
              type="text"
              placeholder="ui-monospace, Menlo, Consolas, monospace"
              {...props.bindText(
                `${idPrefix}.xterm.font_family`,
                () => props.xterm().font_family,
                (v) => props.updateXterm({ font_family: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Font size (px)</span>
            <input
              type="number"
              min="6"
              max="48"
              value={props.xterm().font_size ?? ''}
              placeholder="12"
              onChange={(e) =>
                void props.updateXterm({
                  font_size: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
          </label>
          <label>
            <span>Line height</span>
            <input
              type="number"
              step="0.05"
              min="0.8"
              max="2"
              value={props.xterm().line_height ?? ''}
              placeholder="1.0"
              onChange={(e) =>
                void props.updateXterm({
                  line_height: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
          </label>
          <label>
            <span>Letter spacing (px)</span>
            <input
              type="number"
              step="0.5"
              value={props.xterm().letter_spacing ?? ''}
              placeholder="0"
              onChange={(e) =>
                void props.updateXterm({
                  letter_spacing: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
          </label>
          <label>
            <span>Font weight</span>
            <input
              type="text"
              placeholder="normal | 400 | 500"
              {...props.bindText(
                `${idPrefix}.xterm.font_weight`,
                () =>
                  props.xterm().font_weight !== undefined
                    ? String(props.xterm().font_weight)
                    : undefined,
                (v) => props.updateXterm({ font_weight: v || undefined }),
              )}
            />
          </label>
          <label>
            <span>Bold weight</span>
            <input
              type="text"
              placeholder="bold | 600 | 700"
              {...props.bindText(
                `${idPrefix}.xterm.font_weight_bold`,
                () =>
                  props.xterm().font_weight_bold !== undefined
                    ? String(props.xterm().font_weight_bold)
                    : undefined,
                (v) => props.updateXterm({ font_weight_bold: v || undefined }),
              )}
            />
          </label>
        </div>
      </Subgroup>

      <Subgroup
        id={subgroupId('cursor-buffer')}
        title="Cursor & buffer"
        keywords="cursor blink style scrollback ligatures buffer"
      >
        <div class="settings-grid">
          <label>
            <span>Cursor style</span>
            <select
              value={props.xterm().cursor_style ?? 'block'}
              onChange={(e) =>
                void props.updateXterm({
                  cursor_style: e.currentTarget.value as 'block' | 'underline' | 'bar',
                })
              }
            >
              <For each={CURSOR_STYLES}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
          </label>
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={props.xterm().cursor_blink !== false}
              onChange={(e) => void props.updateXterm({ cursor_blink: e.currentTarget.checked })}
            />
            <span>Cursor blink</span>
          </label>
          <label>
            <span>Scrollback (lines)</span>
            <input
              type="number"
              min="0"
              max="100000"
              value={props.xterm().scrollback ?? ''}
              placeholder="5000"
              onChange={(e) =>
                void props.updateXterm({
                  scrollback: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
          </label>
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={props.xterm().ligatures === true}
              onChange={(e) =>
                void props.updateXterm({ ligatures: e.currentTarget.checked || undefined })
              }
            />
            <span>Programming-font ligatures</span>
          </label>
        </div>
      </Subgroup>

      <Subgroup
        id={subgroupId('colours')}
        title="Colours"
        keywords="colour color ansi foreground background cursor selection palette hex theme"
      >
        <p class="settings-hint">
          Leave a field blank to inherit the active theme. Values are CSS colours (hex, named,{' '}
          <code>color-mix(...)</code>).
        </p>
        <div class="settings-color-grid">
          <For each={TERMINAL_COLORS}>
            {(entry) => (
              <ColorField
                entry={entry}
                idPrefix={idPrefix}
                value={() => props.xterm().colors?.[entry.key]}
                bindText={props.bindText}
                onChange={(v) => props.updateColor(entry.key, v)}
              />
            )}
          </For>
        </div>
        <TerminalColorPreview xterm={props.xterm} />
      </Subgroup>

      <Subgroup
        id={subgroupId('logging')}
        title="Logging"
        keywords="logging record session transcript retention disk size scrollback privacy timestamp interval marker"
      >
        <p class="settings-hint">
          Off by default for privacy. When enabled, every terminal tab records its rendered output
          to <code>.condash/logs/YYYY/MM/DD/HHMMSS-&lt;id&gt;.txt</code> with sidecar
          <code> .meta.json</code>. The <code> .condash/</code> tree is gitignored by default.
          Toggling off does not delete past transcripts — the Logs pane keeps browsing them.
        </p>
        <div class="settings-grid">
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={loggingEnabled()}
              onChange={(e) => void props.updateLogging({ enabled: e.currentTarget.checked })}
            />
            <span>Record terminal sessions to disk</span>
          </label>
          <label>
            <span>Retention (days)</span>
            <input
              type="number"
              min="0"
              max="3650"
              value={logging().retentionDays ?? ''}
              placeholder="14"
              onChange={(e) =>
                void props.updateLogging({
                  retentionDays: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              Day-directories older than this are removed on next janitor run.
              <code> 0</code> disables age-based eviction.
            </small>
          </label>
          <label>
            <span>Max total size (MB)</span>
            <input
              type="number"
              min="0"
              value={logging().maxDirMb ?? ''}
              placeholder="500"
              onChange={(e) =>
                void props.updateLogging({
                  maxDirMb: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              When over this cap, the oldest day-directory is removed first.
            </small>
          </label>
          <label>
            <span>Scrollback (lines)</span>
            <input
              type="number"
              min="100"
              value={logging().scrollback ?? ''}
              placeholder="5000"
              onChange={(e) =>
                void props.updateLogging({
                  scrollback: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              How many lines the headless xterm retains per session. Larger → bigger
              <code> .txt</code> files; smaller → older output rolls off the top.
            </small>
          </label>
          <label>
            <span>Timestamp interval (seconds)</span>
            <input
              type="number"
              min="0"
              value={logging().markerIntervalSec ?? ''}
              placeholder="60"
              onChange={(e) =>
                void props.updateLogging({
                  markerIntervalSec: e.currentTarget.value
                    ? Number(e.currentTarget.value)
                    : undefined,
                })
              }
            />
            <small class="settings-field-hint">
              How often a <code>&lt;!-- timestamp --&gt;</code> marker is written, but only when new
              output has arrived since the last one — an idle session is never stamped.
              <code> 0</code> disables periodic markers.
            </small>
          </label>
        </div>
      </Subgroup>

      <Subgroup
        id={subgroupId('memory')}
        title="Memory containment"
        keywords="memory cap limit oom crash scope systemd cgroup runaway agent leak backstop MemoryMax MemorySwapMax swap"
      >
        <p class="settings-hint">
          Linux + systemd only (ignored elsewhere). Each terminal tab runs inside its own
          memory-limited <code>systemd</code> scope, so a runaway agent is OOM-killed alone instead
          of pressuring the whole machine. The app-scope backstop caps condash's own scope too, so a
          child that ever escapes the per-tab cap still can't trigger a whole-session OOM. Sizes are
          systemd strings, e.g. <code>8G</code>, <code>512M</code>.
        </p>
        <div class="settings-grid">
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={memoryEnabled()}
              onChange={(e) =>
                void props.updateMemory({ enabled: e.currentTarget.checked ? undefined : false })
              }
            />
            <span>Contain each tab in its own memory scope</span>
          </label>
          <label>
            <span>Per-tab soft limit (MemoryHigh)</span>
            <input
              type="text"
              value={memory().high ?? ''}
              placeholder="6G"
              onChange={(e) =>
                void props.updateMemory({ high: e.currentTarget.value.trim() || undefined })
              }
            />
            <small class="settings-field-hint">
              Past this the kernel throttles and reclaims the tab, buying time before the hard cap.
            </small>
          </label>
          <label>
            <span>Per-tab hard cap (MemoryMax)</span>
            <input
              type="text"
              value={memory().max ?? ''}
              placeholder="8G"
              onChange={(e) =>
                void props.updateMemory({ max: e.currentTarget.value.trim() || undefined })
              }
            />
            <small class="settings-field-hint">
              A tab exceeding this trips its own cgroup OOM and dies alone.
            </small>
          </label>
          <label>
            <span>Per-tab swap cap (MemorySwapMax)</span>
            <input
              type="text"
              value={memory().swapMax ?? ''}
              placeholder="2G"
              onChange={(e) =>
                void props.updateMemory({ swapMax: e.currentTarget.value.trim() || undefined })
              }
            />
            <small class="settings-field-hint">
              Stops a capped tab from exhausting system swap instead.
            </small>
          </label>
          <label class="settings-checkbox">
            <input
              type="checkbox"
              checked={appScopeEnabled()}
              onChange={(e) =>
                void props.updateAppScopeMemory({
                  enabled: e.currentTarget.checked ? undefined : false,
                })
              }
            />
            <span>Backstop: cap condash’s own scope (prevents whole-session OOM)</span>
          </label>
          <label>
            <span>App-scope hard cap (MemoryMax)</span>
            <input
              type="text"
              value={appScope().max ?? ''}
              placeholder="auto (RAM − 3G)"
              onChange={(e) =>
                void props.updateAppScopeMemory({ max: e.currentTarget.value.trim() || undefined })
              }
            />
            <small class="settings-field-hint">
              Applied to condash’s app scope at startup. Default: physical RAM minus a reserve.
            </small>
          </label>
          <label>
            <span>App-scope swap cap (MemorySwapMax)</span>
            <input
              type="text"
              value={appScope().swapMax ?? ''}
              placeholder="2G"
              onChange={(e) =>
                void props.updateAppScopeMemory({
                  swapMax: e.currentTarget.value.trim() || undefined,
                })
              }
            />
            <small class="settings-field-hint">
              The lever that stops a runaway from thrashing all of system swap.
            </small>
          </label>
        </div>
      </Subgroup>
    </>
  );
}
