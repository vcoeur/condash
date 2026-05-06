import { onCleanup, onMount } from 'solid-js';

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
      { keys: 'Ctrl + N', description: 'New project' },
      { keys: 'Ctrl + ,', description: 'Open settings' },
      { keys: 'F5', description: 'Refresh tree, repos, and dirty counts' },
      { keys: 'Esc', description: 'Close the topmost modal' },
      { keys: '?', description: 'Toggle this overlay' },
    ],
  },
  {
    title: 'Panes',
    entries: [{ keys: 'Ctrl + `', description: 'Toggle Terminal' }],
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
  const handleKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      props.onClose();
    }
  };
  onMount(() => document.addEventListener('keydown', handleKey, true));
  onCleanup(() => document.removeEventListener('keydown', handleKey, true));

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal shortcuts-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">Keyboard shortcuts</span>
          <span class="modal-head-spacer" />
          <button
            class="modal-button"
            onClick={props.onClose}
            title="Close (Esc / ?)"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div class="shortcuts-grid">
          {GROUPS.map((group) => (
            <section class="shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                {group.entries.map((entry) => (
                  <>
                    <dt>
                      <kbd>{entry.keys}</kbd>
                    </dt>
                    <dd>{entry.description}</dd>
                  </>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
