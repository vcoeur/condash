/**
 * Auto-commit section of the Settings modal — a personal (per-machine) setting.
 *
 * Configures the auto-sync engine in the main process: while a conception is
 * open, it runs `condash sync run` on a timer, committing every settled,
 * non-gitignored change and pushing. All the safety (lock, quiet period,
 * mid-merge refusal, push-retry) lives in the engine; this just edits the
 * cadence and shows live status.
 */

import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { AutoSyncSettings, AutoSyncStatus } from '@shared/types';
import { type RawConfig } from './data';
import { SectionShell } from './section-shell';
import { Button } from '../actions';

interface SyncSectionProps {
  /** Draft-aware getter for the global file. */
  parsed: () => RawConfig;
  /** Stage a mutation to the global draft. */
  patch: (mutator: (config: RawConfig) => void) => Promise<void>;
}

/** "3 min ago" / "in 4 min" / "just now" for an epoch-ms timestamp. */
function relTime(epochMs: number | null): string {
  if (!epochMs) return '—';
  const deltaSec = Math.round((epochMs - Date.now()) / 1000);
  const ahead = deltaSec > 0;
  const abs = Math.abs(deltaSec);
  if (abs < 45) return ahead ? 'in <1 min' : 'just now';
  const mins = Math.round(abs / 60);
  return ahead ? `in ${mins} min` : `${mins} min ago`;
}

function phaseLabel(status: AutoSyncStatus): string {
  switch (status.phase) {
    case 'disabled':
      return 'Off';
    case 'syncing':
      return 'Committing…';
    case 'error':
      return 'Last sweep failed';
    case 'idle':
      return status.lastRunAt ? 'Idle' : 'Waiting for first sweep';
  }
}

export function SyncSection(props: SyncSectionProps): JSX.Element {
  const autoSync = (): AutoSyncSettings => props.parsed().autoSync ?? {};
  const update = (partial: Partial<AutoSyncSettings>): Promise<void> =>
    props.patch((config) => {
      config.autoSync = { ...config.autoSync, ...partial };
    });

  const [status, setStatus] = createSignal<AutoSyncStatus | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void window.condash.autoSyncGetStatus().then(setStatus);
    const unsubscribe = window.condash.onAutoSyncStatus(setStatus);
    onCleanup(unsubscribe);
  });

  const commitNow = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await window.condash.autoSyncNow());
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionShell
      id="auto-sync"
      title="Auto-commit"
      scope="global"
      hint={
        <p class="settings-hint">
          While a conception is open, condash can commit and push settled changes on a timer —
          running <code>condash sync run</code> for you, so a checkout shared by parallel agent
          sessions has one writer. Off by default. Files edited within the quiet period are left for
          the next sweep, so work in progress is never committed half-written. To keep a file out of
          auto-commit, gitignore it.
        </p>
      }
    >
      <div class="settings-grid">
        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={autoSync().enabled ?? false}
            onChange={(e) => void update({ enabled: e.currentTarget.checked })}
          />
          <span>Automatically commit &amp; push on a timer</span>
        </label>

        <label>
          <span>Commit interval (minutes)</span>
          <input
            type="number"
            min="1"
            max="120"
            placeholder="10"
            value={autoSync().intervalMinutes ?? ''}
            onChange={(e) =>
              void update({
                intervalMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            How often to sweep and commit. Clamped to 1–120. Default 10.
          </small>
        </label>

        <label>
          <span>Quiet period (seconds)</span>
          <input
            type="number"
            min="0"
            max="3600"
            placeholder="90"
            value={autoSync().quietPeriodSeconds ?? ''}
            onChange={(e) =>
              void update({
                quietPeriodSeconds: e.currentTarget.value
                  ? Number(e.currentTarget.value)
                  : undefined,
              })
            }
          />
          <small class="settings-field-hint">
            A file edited more recently than this is left for the next sweep — the guard against
            committing mid-edit. Default 90. Set 0 to commit even just-touched files.
          </small>
        </label>

        <label class="settings-checkbox">
          <input
            type="checkbox"
            checked={autoSync().push ?? true}
            onChange={(e) => void update({ push: e.currentTarget.checked })}
          />
          <span>Push after committing</span>
        </label>
      </div>

      <div class="settings-dashboard-test">
        <Button type="button" variant="default" disabled={busy()} onClick={() => void commitNow()}>
          {busy() ? 'Committing…' : 'Commit & push now'}
        </Button>
        <Show when={status()} keyed>
          {(current) => (
            <span class="settings-field-hint">
              {phaseLabel(current)}
              <Show when={current.enabled && current.nextRunAt}>
                {' · next '}
                {relTime(current.nextRunAt)}
              </Show>
              <Show when={current.lastResult} keyed>
                {(result) => (
                  <>
                    {' · last: '}
                    {result.committed} commit{result.committed === 1 ? '' : 's'}
                    {result.pushed ? ', pushed' : ''} {relTime(current.lastRunAt)}
                  </>
                )}
              </Show>
              <Show when={current.lastError} keyed>
                {(error) => <span class="settings-dashboard-test-error"> · ✗ {error}</span>}
              </Show>
            </span>
          )}
        </Show>
      </div>
    </SectionShell>
  );
}
