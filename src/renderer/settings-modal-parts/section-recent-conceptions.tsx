import { createResource, createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { SectionShell } from './section-shell';
import { Button } from '../actions';

/**
 * Per-machine list of recently-opened conception paths (Personal group). Each
 * row shows the path plus an inline "Remove" button; "Clear all" drops the
 * whole list. Re-fetched whenever `version` changes — bumped on every
 * successful mutation so the list refreshes without a full modal reload.
 */
export function RecentConceptionsSection(): JSX.Element {
  const [version, setVersion] = createSignal(0);
  const [recents] = createResource(version, () => window.condash.getRecentConceptionPaths());

  const handleRemove = async (path: string): Promise<void> => {
    await window.condash.removeRecentConceptionPath(path);
    setVersion((v) => v + 1);
  };

  const handleClear = async (): Promise<void> => {
    await window.condash.clearRecentConceptionPaths();
    setVersion((v) => v + 1);
  };

  const handleOpen = (path: string): void => {
    void window.condash.openConception(path);
  };

  return (
    <SectionShell
      id="recents"
      title="Recent conceptions"
      scope="global"
      hint={
        <p class="settings-section-hint">
          Newest first. Drives the File → Open Recent submenu. Removing a path here also removes it
          from the menu — your active conception is unaffected.
        </p>
      }
    >
      <Show
        when={(recents() ?? []).length > 0}
        fallback={
          <div class="settings-empty">
            <p>No recent conceptions yet.</p>
            <p class="settings-empty-hint">
              Use <kbd>File → Open conception…</kbd> or drop a folder on the dock icon to add one.
            </p>
          </div>
        }
      >
        <ul class="settings-recents-list">
          <For each={recents()}>
            {(path) => (
              <li class="settings-recents-row">
                <button
                  type="button"
                  class="settings-recents-open"
                  onClick={() => handleOpen(path)}
                  title="Switch to this conception"
                >
                  <code class="settings-recents-path">{path}</code>
                </button>
                <Button
                  type="button"
                  variant="default"
                  class="settings-recents-remove"
                  onClick={() => void handleRemove(path)}
                  title="Remove from recents"
                  aria-label={`Remove ${path} from recents`}
                >
                  ×
                </Button>
              </li>
            )}
          </For>
        </ul>
        <div class="settings-recents-actions">
          <Button type="button" variant="default" onClick={() => void handleClear()}>
            Clear all
          </Button>
        </div>
      </Show>
    </SectionShell>
  );
}
