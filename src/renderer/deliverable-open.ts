import type { Setter } from 'solid-js';
import type { ModalState } from './modal-types';
import { categorise } from '@shared/file-category';

export interface DeliverableOpenSetters {
  setPdfPath: Setter<string | null>;
  setHtmlPath: Setter<string | null>;
  setImagePath: Setter<string | null>;
  setMdxPath: Setter<string | null>;
  setModal: Setter<ModalState>;
}

/**
 * Open a file/URL target in the right surface. `target` is either a resolved
 * local path or a verbatim http(s) URL (`Deliverable.path`). Local files are
 * classified by `categorise` (the same classifier the Resources pane uses), so
 * every pane opens a given file type the same way:
 *
 *   - http(s) URL → external browser
 *   - pdf         → in-app PDF modal
 *   - html        → in-app HTML preview (rendered, with a source toggle)
 *   - image       → in-app image viewer
 *   - mdx         → in-app plan/recap viewer (typed blocks, source toggle)
 *   - markdown    → in-app read-only markdown viewer
 *   - text/code   → in-app read-only, syntax-highlighted viewer
 *   - everything else → OS default application
 *
 * Shared by the project-preview deliverables list, the knowledge/resources
 * tree, and the Deliverables pane so every artifact routes identically.
 */
export function openDeliverableTarget(target: string, setters: DeliverableOpenSetters): void {
  if (/^https?:\/\//i.test(target)) {
    void window.condash.openExternal(target);
    return;
  }
  // Classify on the basename so a dotted parent directory can't be mistaken
  // for an extension.
  const base = target.split(/[/\\]/).pop() ?? target;
  switch (categorise(base)) {
    case 'pdf':
      setters.setPdfPath(target);
      return;
    case 'html':
      setters.setHtmlPath(target);
      return;
    case 'image':
      setters.setImagePath(target);
      return;
    case 'mdx':
      setters.setMdxPath(target);
      return;
    case 'markdown':
    case 'text':
      setters.setModal({ path: target, readOnly: true });
      return;
    default:
      void window.condash.openPath(target);
  }
}
