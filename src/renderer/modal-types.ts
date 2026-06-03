import type { Deliverable } from '@shared/types';

/**
 * Central state for the note/preview modal that the back-stack router
 * (`modal-router.ts`) and the modal signal bag (`hooks/use-modals.ts`) pivot
 * on. Lives in this neutral module — not inside `note-modal.tsx` — so the
 * router can be read without opening the leaf component and there is no
 * router→leaf back-edge.
 *
 * The router only cares about `path` / `title` / `backLabel`; the remaining
 * fields are note-modal display options carried alongside.
 */
export type ModalState = {
  path: string;
  title?: string;
  /** Force edit mode on open (used by the preferences modal). */
  initialMode?: 'view' | 'edit';
  /** Deliverables to surface as a section above the rendered body, when known. */
  deliverables?: Deliverable[];
  /** When set, render a leading "← Back to <label>" button in the modal head.
   * Clicking it calls onClose, which the parent routes back to the originating
   * preview via the previewBackPath plumbing. */
  backLabel?: string;
  /** Open the modal in read-only mode — no save / edit toggle. Used by the
   * Resources pane for `.md` and `.txt` viewing. */
  readOnly?: boolean;
  /** Render an informational banner above the body. `'shipped'` flags a file
   * tracked by `.condash-skills.json` whose disk SHA matches the manifest;
   * `'shipped-diverged'` flags a local edit. */
  bannerKind?: 'shipped' | 'shipped-diverged';
  /** Which IPC reads the body. `'skill'` uses `readSkillFile` (permits the
   * user-scope skill / agent-config locations the global Skills scope lives
   * in); the default reads `readNote` (conception-bounded). */
  readWith?: 'note' | 'skill';
} | null;
