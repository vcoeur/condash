/**
 * Note-specific modal-head icons (edit / view / save). The shared
 * `IconClose` / `IconExternal` glyphs live in the global `../icons` shelf —
 * the note modal imports them from there so the close-X and external-link
 * affordances read identically everywhere, rather than from divergent copies.
 */

export function IconEdit() {
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
      <path d="M11.5 2.5l2 2-7.5 7.5H4v-2z" />
      <path d="M10 4l2 2" />
    </svg>
  );
}

export function IconView() {
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
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.6" />
    </svg>
  );
}

export function IconSave() {
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
      <path d="M2.5 2.5h8.5L13.5 5v8.5h-11z" />
      <path d="M5 2.5v3h5v-3" />
      <rect x="4.5" y="9" width="7" height="4.5" />
    </svg>
  );
}
