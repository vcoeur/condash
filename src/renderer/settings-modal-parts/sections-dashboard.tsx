/**
 * Dashboard section of the Settings modal — a personal (per-machine) setting.
 *
 * Configures the live terminal-tab summarization feature (the engine in the
 * main process). The secret `apiKey` and the endpoint (`baseUrl` / `model`)
 * live in the global `settings.json` only, never a tree's settings file — the
 * whole block is personal, so it renders once under the Personal group.
 */

import { createSignal, Show, type JSX } from 'solid-js';
import type { DashboardSettings } from '@shared/types';
import { type RawConfig } from './data';
import { SectionShell } from './section-shell';

/** Inline result of the "Test connection" probe. */
type TestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

interface DashboardSectionProps {
  /** Draft-aware getter for the global file. */
  parsed: () => RawConfig;
  /** Stage a mutation to the global draft. */
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
}

export function DashboardSection(props: DashboardSectionProps): JSX.Element {
  const dashboard = (): DashboardSettings => props.parsed().dashboard ?? {};
  const update = (partial: Partial<DashboardSettings>): Promise<void> =>
    props.patch((config) => {
      config.dashboard = { ...config.dashboard, ...partial };
    });

  const [test, setTest] = createSignal<TestState>({ status: 'idle' });
  const testError = (): string => {
    const t = test();
    return t.status === 'error' ? t.message : '';
  };
  const runTest = async (): Promise<void> => {
    setTest({ status: 'testing' });
    try {
      // Test the draft values (key/url/model the user is editing), not the
      // on-disk config — so they can verify before saving.
      const result = await window.condash.dashboardTestConnection(dashboard());
      setTest(
        result.ok
          ? { status: 'ok' }
          : { status: 'error', message: result.error ?? 'Unknown error.' },
      );
    } catch (err) {
      setTest({ status: 'error', message: (err as Error).message });
    }
  };

  return (
    <SectionShell
      id="dashboard"
      title="Dashboard"
      scope="global"
      hint={
        <>
          <p class="settings-hint">
            Periodically summarize what your terminal tabs are doing, surfaced as live tab titles, a
            hover popover, and the Dashboard handle next to Terminal. Off by default.
          </p>
          <p class="settings-hint">
            <strong>Privacy:</strong> when enabled, recent terminal output is sent to the configured
            API endpoint (the DeepSeek API by default). Don't enable it for tabs that display
            secrets you don't want transmitted.
          </p>
        </>
      }
    >
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
          <span>API key</span>
          <input
            type="password"
            autocomplete="off"
            placeholder="sk-…"
            value={dashboard().apiKey ?? ''}
            onChange={(e) => void update({ apiKey: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Stored in this machine's <code>settings.json</code> only. Leave blank to fall back to
            the
            <code> DEEPSEEK_API_KEY</code> environment variable.
          </small>
        </label>
        <label>
          <span>API base URL</span>
          <input
            type="text"
            placeholder="https://api.deepseek.com"
            value={dashboard().baseUrl ?? ''}
            onChange={(e) => void update({ baseUrl: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Optional. Blank uses the DeepSeek API. Set an OpenAI-compatible endpoint (e.g. an
            opencode-go server) to use any <em>Model</em> id it serves.
          </small>
        </label>
        <label>
          <span>Model</span>
          <input
            type="text"
            placeholder="deepseek-v4-flash"
            value={dashboard().model ?? ''}
            onChange={(e) => void update({ model: e.currentTarget.value.trim() || undefined })}
          />
          <small class="settings-field-hint">
            Default <code>deepseek-v4-flash</code>. Without a base URL it must be a built-in
            DeepSeek model (<code>deepseek-v4-flash</code> or <code>deepseek-v4-pro</code>).
          </small>
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

      <div class="settings-dashboard-test">
        <button
          type="button"
          class="modal-button"
          disabled={!dashboard().apiKey || test().status === 'testing'}
          onClick={() => void runTest()}
        >
          {test().status === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <Show when={test().status === 'ok'}>
          <span class="settings-dashboard-test-ok">✓ Connection OK</span>
        </Show>
        <Show when={test().status === 'error'}>
          <span class="settings-dashboard-test-error">✗ {testError()}</span>
        </Show>
      </div>
    </SectionShell>
  );
}
