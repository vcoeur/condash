import { createSignal } from 'solid-js';

/**
 * Reference panel surfaced above the rendered body when the open file is
 * `condash.json` / `configuration.json`. A short `<details>` summary of the
 * top-level keys with a button that opens the full doc.
 */

const CONFIG_SUMMARY: { key: string; purpose: string }[] = [
  { key: 'workspace_path', purpose: 'Base directory for non-absolute repo entries.' },
  { key: 'worktrees_path', purpose: 'Where new git worktrees are created (informational).' },
  {
    key: 'repositories',
    purpose:
      'Ordered list of repos shown on the Code pane. Each entry: name, optional run / force_stop / submodules. Insert a { "section": "…" } entry to group every repo that follows it under a header.',
  },
  {
    key: 'open_with',
    purpose:
      'IDE / terminal launchers (main_ide, secondary_ide, terminal). {path} substitutes the target.',
  },
  {
    key: 'terminal',
    purpose:
      'Pane preferences: shell, shortcut, screenshot_dir, screenshot_paste_shortcut, launcher_command.',
  },
];

export function ConfigSummaryPanel(props: { onOpenFullDoc: () => void }) {
  const [open, setOpen] = createSignal(true);
  return (
    <details
      class="config-summary-panel"
      open={open()}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        Reference — top-level keys
        <button
          class="modal-button config-summary-link"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onOpenFullDoc();
          }}
          title="Open the full configuration reference"
        >
          Full reference →
        </button>
      </summary>
      <ul class="config-summary-list">
        {CONFIG_SUMMARY.map((row) => (
          <li>
            <code>{row.key}</code>
            <span> — {row.purpose}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
