/* Shared icon vocabulary.
 *
 * All icons share a 16×16 viewBox, currentColor stroke, round caps and joins,
 * and an optional duotone accent (currentColor at fill-opacity 0.16-0.22)
 * inside the stroked silhouette. Stroke weights come from CSS so the icons
 * read consistently across containers.
 *
 * The Projects pane established this vocabulary first (see projects.tsx for
 * its kind/step/warn icons); the Code pane pulls from the same shelf so the
 * two panes feel like one app. */

// Terminal — rounded window, chunky `>` chevron, and a filled cursor block.
// Reads as "command line with a live cursor". Used for the projects-pane
// "work on" action and the code-pane "open shell in terminal tab" action.
export function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.75" />
      <path d="M4 6.25L6.5 8.25 4 10.25" />
      <rect x="8.25" y="9.5" width="3.5" height="1.5" rx="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Run — chunky play triangle with a soft duotone fill. Drives the run:
// command on the code-pane card.
export function RunIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3.25L13 8 5 12.75z" fill="currentColor" fill-opacity="0.22" />
    </svg>
  );
}

// Stop — filled rounded square. Used for both the per-card live-session
// stop and the active-run-row stop. The shape reads "halt" cleanly even
// at small sizes.
export function StopIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.4" fill="currentColor" />
    </svg>
  );
}

// Kill / force-stop — circle with an X, plus a faint duotone wash so the
// silhouette holds at small sizes. Shares the duotone-on-circle treatment
// of WarnIcon in projects.tsx — same family, different verb.
export function KillIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" fill="currentColor" fill-opacity="0.16" />
      <circle cx="8" cy="8" r="6" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
    </svg>
  );
}

// Chevron down — triggers the open_with menu. Stroked, rounded caps, in
// the same vocabulary as the rest of the icon set instead of the plain
// `▾` text glyph.
export function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5L8 10.5 12 6.5" />
    </svg>
  );
}

// Chevron right — the canonical disclosure chevron. Points right when
// collapsed; the `Caret` wrapper rotates it 90° (→ down) when expanded.
// Replaces the literal `▸` / `▾` text triangles that disclosure headers,
// run rows, tree folders and settings groups each rendered by hand.
export function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

/**
 * Disclosure caret — one rotatable chevron for every collapsible surface
 * (status group, run row, tree folder, settings group, timeline). Points
 * right when collapsed and rotates down when `expanded`, via the shared
 * `.caret-icon` rule in primitives.css. Pass `expanded` from the surface's
 * own open state.
 */
export function Caret(props: { expanded?: boolean; class?: string }) {
  return (
    <span
      class={props.class ? `caret-icon ${props.class}` : 'caret-icon'}
      data-expanded={props.expanded ? 'true' : 'false'}
      aria-hidden="true"
    >
      <ChevronIcon />
    </span>
  );
}

// Book — open codex with a centred binding line and a soft duotone wash
// across both pages. The Knowledge-pane card glyph: literary, archival,
// distinct from the Document kind glyph (single-page) and the Folder
// (file-manager) icon.
export function BookIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M2 3.5h4.25c.7 0 1.25.55 1.25 1.25V13c0-.7-.55-1.25-1.25-1.25H2zM14 3.5H9.75c-.7 0-1.25.55-1.25 1.25V13c0-.7.55-1.25 1.25-1.25H14z"
        fill="currentColor"
        fill-opacity="0.18"
      />
      <path d="M2 3.5h4.25c.7 0 1.25.55 1.25 1.25V13c0-.7-.55-1.25-1.25-1.25H2zM14 3.5H9.75c-.7 0-1.25.55-1.25 1.25V13c0-.7.55-1.25 1.25-1.25H14z" />
      <path d="M8 4.75v8" stroke-opacity="0.5" />
    </svg>
  );
}

// Close (×) — used by every modal-head close button. Stroke-width comes
// from CSS so a heavier modal head can override; the default 1.6 reads at
// 16×16 in both light and dark themes.
export function IconClose() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

// External — corner-arrow inside a frame. "Open in main IDE / file
// manager" actions use this. Same vocabulary as ChevronDownIcon — stroked,
// rounded, currentColor.
export function IconExternal() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 2.5H2.5v11h11V11" />
      <path d="M9 2.5h4.5V7" />
      <path d="M13.5 2.5L7 9" />
    </svg>
  );
}

// Folder — tabbed silhouette with a soft duotone fill. The "open in file
// manager" entry uses this in the open_with menu, replacing the standalone
// 📁 button on the card face.
export function FolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M2 5.25c0-.7.55-1.25 1.25-1.25H6L7.5 5.5h5.25c.7 0 1.25.55 1.25 1.25v5c0 .7-.55 1.25-1.25 1.25H3.25C2.55 13 2 12.45 2 11.75V5.25z"
        fill="currentColor"
        fill-opacity="0.18"
      />
    </svg>
  );
}

// Refresh — a clockwise circular arrow (reload), feather's rotate-cw scaled
// to the 16×16 shelf. Backs the active terminal tab's in-title repaint button.
export function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M13.7 10a6 6 0 1 1-1.4-6.24L15.3 6.7" />
      <polyline points="15.3 2.7 15.3 6.7 11.3 6.7" />
    </svg>
  );
}

// Rail icons — 24×24 viewBox, slightly heavier stroke so they read at 20 px.

/** Projects rail icon — folder with a small dot, suggesting the project inbox. */
export function ProjectsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 1-2-2Z" />
      <path d="M7 7h0" />
    </svg>
  );
}

/** Tasks rail icon — checkmark, the universal done/undo language. */
export function TasksIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

/** Deliverables rail icon — shield, signifying shipped artifacts. */
export function DeliverablesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" />
    </svg>
  );
}

/** Code rail icon — angle brackets, the classic code symbol. */
export function CodeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

/** Knowledge rail icon — open book. */
export function KnowledgeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

/** Resources rail icon — download into a box. */
export function ResourcesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

/** Skills rail icon — stacked layers. */
export function SkillsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

/** Logs rail icon — file with lines. */
export function LogsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}
