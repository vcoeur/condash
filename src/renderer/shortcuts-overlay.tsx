import { For, onCleanup, onMount } from 'solid-js';
import { Modal } from './modal';
import './shortcuts-overlay.css';

interface ShortcutEntry {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    entries: [
      { keys: 'Ctrl + K', description: 'Open search' },
      { keys: 'Ctrl + Shift + F', description: 'Open search modal (alias)' },
      { keys: 'Ctrl + N', description: 'New project' },
      { keys: 'Ctrl + ,', description: 'Open settings' },
      { keys: 'F5', description: 'Refresh tree, repos, and dirty counts' },
      { keys: 'Ctrl + Shift + R', description: 'Reload window (hard reload)' },
      { keys: 'Esc', description: 'Close the topmost modal' },
      { keys: '?', description: 'Toggle this overlay' },
    ],
  },
  {
    title: 'Panes',
    entries: [
      { keys: 'Ctrl + R', description: 'Show Resources pane' },
      { keys: 'Ctrl + L', description: 'Show Skills pane' },
      { keys: 'Ctrl + Shift + L', description: 'Show Logs pane' },
      { keys: 'Ctrl + `', description: 'Toggle Terminal' },
    ],
  },
  {
    title: 'Project cards',
    entries: [
      { keys: 'Tab', description: 'Move focus between cards' },
      { keys: 'Ctrl + 1', description: 'Set focused card status to now' },
      { keys: 'Ctrl + 2', description: 'Set focused card status to review' },
      { keys: 'Ctrl + 3', description: 'Set focused card status to later' },
      { keys: 'Ctrl + 4', description: 'Set focused card status to backlog' },
      { keys: 'Ctrl + 5', description: 'Set focused card status to done' },
    ],
  },
  {
    title: 'Note modal',
    entries: [
      { keys: 'Ctrl + E', description: 'Toggle view / edit mode' },
      { keys: 'Ctrl + S', description: 'Save current edits' },
      { keys: 'Ctrl + F', description: 'Find in note (view mode)' },
      { keys: 'Esc', description: 'Close note (or close find bar)' },
    ],
  },
  {
    title: 'Terminal',
    entries: [
      { keys: 'Ctrl + Left/Right', description: 'Move active tab between columns' },
      { keys: 'Ctrl + F', description: 'Search the active terminal buffer' },
    ],
  },
];

/**
 * Cheat-sheet overlay shown when the user presses `?`. Renders on top of
 * everything (modal-backdrop) and dismisses on Esc, on `?` again, or on
 * a backdrop click. Static content — the bundled docs are the source of
 * truth, this overlay is the at-a-glance reference for the most common
 * shortcuts.
 */
export function ShortcutsOverlay(props: { onClose: () => void }) {
  // Esc → close and backdrop dismissal are owned by the shared <Modal>
  // shell. The overlay additionally closes on `?` and, being the topmost
  // surface, swallows every other shortcut so Ctrl+K / Ctrl+` etc. don't
  // fire underneath it.
  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === '?') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      return;
    }
    if (e.key === 'Escape') return; // handled by the shell
    e.stopPropagation();
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  return (
    <Modal
      class="shortcuts-overlay"
      ariaLabel="Keyboard shortcuts"
      title="Keyboard shortcuts"
      onClose={props.onClose}
      closeTitle="Close (Esc / ?)"
    >
      <div class="shortcuts-grid">
        <For each={GROUPS}>
          {(group) => (
            <section class="shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                <For each={group.entries}>
                  {(entry) => (
                    <>
                      <dt>
                        <kbd>{entry.keys}</kbd>
                      </dt>
                      <dd>{entry.description}</dd>
                    </>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
    </Modal>
  );
}
