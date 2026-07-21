// Pane-local glyphs for the preview's file tree. 16×16 viewBox, stroke
// weight matched to the shared icon set in ../icons.tsx.

/** Page outline with a plus — the per-dir "new file" affordance. */
export function IconNewFile() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 1.75H4.25c-.55 0-1 .45-1 1v10.5c0 .55.45 1 1 1h7.5c.55 0 1-.45 1-1V5.5L9 1.75z" />
      <path d="M9 1.75V5.5h3.75" />
      <path d="M8 8v3M6.5 9.5h3" />
    </svg>
  );
}

/** Folder outline with a plus — the per-dir "new folder" affordance. */
export function IconNewFolder() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 4.5c0-.55.45-1 1-1h3l1.5 1.75h6c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1V4.5z" />
      <path d="M8 7.75v3M6.5 9.25h3" />
    </svg>
  );
}
