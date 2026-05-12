import { createResource, createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';

/**
 * Per-machine list of recently-opened conception paths, displayed on the
 * Global tab. Each row shows the basename + dimmed parent path, plus an
 * inline "Remove" button. A "Clear all" button at the foot drops the
 * whole list. Reactivity: re-fetched whenever `version` changes — the
 * component bumps it on every successful mutation so the list refreshes
 * without a full modal reload.
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

  return (
    <section id="settings-section-recents:global" class="settings-section">
      <h2>Recent conception paths</h2>
      <p class="settings-section-hint">
        Newest first. Drives the File → Open Recent submenu. Removing a path here also removes it
        from the menu — your active conception is unaffected.
      </p>
      <Show
        when={(recents() ?? []).length > 0}
        fallback={<p class="settings-empty">No recents yet.</p>}
      >
        <ul class="settings-recents-list">
          <For each={recents()}>
            {(path) => (
              <li class="settings-recents-row">
                <code class="settings-recents-path">{path}</code>
                <button
                  type="button"
                  class="modal-button"
                  onClick={() => void handleRemove(path)}
                  title="Remove from recents"
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
        <div class="settings-recents-actions">
          <button type="button" class="modal-button" onClick={() => void handleClear()}>
            Clear all
          </button>
        </div>
      </Show>
    </section>
  );
}
