/**
 * Dashboard section of the Settings modal — global-only.
 *
 * Configures the live terminal-tab summarization feature (the engine in the
 * main process). Global-only on purpose: the `apiKey` is a secret and must not
 * land in a conception's versioned condash.json, so unlike Appearance / Terminal
 * / Agents this section is not mirrored on the conception tab. Writes go to
 * settings.json via `patchSettings`.
 */

import { type JSX } from 'solid-js';
import type { DashboardSettings } from '@shared/types';
import { type RawConfig } from './data';

interface DashboardSectionProps {
  /** Draft-aware getter for the global settings.json config. */
  parsed: () => RawConfig;
  /** Stage a mutation to the global settings draft. */
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
}

export function DashboardSection(props: DashboardSectionProps): JSX.Element {
  const dashboard = (): DashboardSettings => props.parsed().dashboard ?? {};
  const update = (partial: Partial<DashboardSettings>): Promise<void> =>
    props.patch((config) => {
      config.dashboard = { ...config.dashboard, ...partial };
    });

  return (
    <section id="settings-section-dashboard:global" class="settings-section">
      <h2>Dashboard</h2>
      <p class="settings-hint">
        Periodically summarize what your terminal tabs are doing, surfaced as live tab titles, a
        hover popover, and the Dashboard pane. Off by default.
      </p>
      <p class="settings-hint">
        <strong>Privacy:</strong> when enabled, recent terminal output is sent to the DeepSeek API
        (an external service). Don't enable it for tabs that display secrets you don't want
        transmitted.
      </p>
      <div class="settings-grid">
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={dashboard().enabled ?? false}
            onChange={(e) => void update({ enabled: e.currentTarget.checked })}
          />
          <span>Enable live tab summaries</span>
        </label>
        <label>
          <span>DeepSeek API key</span>
          <input
            type="password"
            autocomplete="off"
            placeholder="sk-…"
            value={dashboard().apiKey ?? ''}
            onChange={(e) => void update({ apiKey: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Stored in this machine's <code>settings.json</code> only — never written to a
            conception's <code>condash.json</code>. Leave blank to fall back to the
            <code> DEEPSEEK_API_KEY</code> environment variable.
          </small>
        </label>
        <label>
          <span>Model</span>
          <input
            type="text"
            placeholder="deepseek-chat"
            value={dashboard().model ?? ''}
            onChange={(e) => void update({ model: e.currentTarget.value.trim() || undefined })}
          />
        </label>
        <label>
          <span>Update interval (seconds)</span>
          <input
            type="number"
            min="30"
            max="300"
            placeholder="120"
            value={dashboard().intervalSec ?? ''}
            onChange={(e) =>
              void update({
                intervalSec: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            Clamped to 30–300. Only tabs with new output are summarized each cycle.
          </small>
        </label>
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={dashboard().gateOnActivity ?? true}
            onChange={(e) => void update({ gateOnActivity: e.currentTarget.checked })}
          />
          <span>Only summarize tabs that produced new output</span>
        </label>
      </div>
    </section>
  );
}
