import type { Setter } from 'solid-js';
import type { ModalState } from './note-modal';

export interface DeliverableOpenSetters {
  setPdfPath: Setter<string | null>;
  setHtmlPath: Setter<string | null>;
  setModal: Setter<ModalState>;
}

/**
 * Open a deliverable target by type. `target` is either a resolved local path
 * or a verbatim http(s) URL (`Deliverable.path`):
 *
 *   - http(s) URL → external browser
 *   - .pdf        → in-app PDF modal
 *   - .html/.htm  → in-app HTML preview
 *   - .md         → in-app read-only markdown viewer
 *   - everything else → OS default application
 *
 * Shared by the project-preview deliverables list and the Outputs pane so both
 * route every artifact the same way.
 */
export function openDeliverableTarget(target: string, setters: DeliverableOpenSetters): void {
  const lower = target.toLowerCase();
  if (/^https?:\/\//i.test(target)) {
    void window.condash.openExternal(target);
    return;
  }
  if (lower.endsWith('.pdf')) {
    setters.setPdfPath(target);
    return;
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    setters.setHtmlPath(target);
    return;
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    setters.setModal({ path: target, readOnly: true });
    return;
  }
  void window.condash.openPath(target);
}
