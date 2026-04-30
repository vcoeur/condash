/* Shared icon vocabulary.
 *
 * All icons share a 16×16 viewBox, currentColor stroke, round caps and joins,
 * and an optional duotone accent (currentColor at fill-opacity 0.16-0.22)
 * inside the stroked silhouette. Stroke weights come from CSS so the icons
 * read consistently across containers.
 *
 * The Projects tab established this vocabulary first (see projects.tsx for
 * its kind/step/warn icons); the Code tab pulls from the same shelf so the
 * two tabs feel like one app. */

// Terminal — rounded window, chunky `>` chevron, and a filled cursor block.
// Reads as "command line with a live cursor". Used for the projects-tab
// "work on" action and the code-tab "open shell in terminal tab" action.
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
// command on the code-tab card.
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
