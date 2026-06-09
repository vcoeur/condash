import { describe, expect, it } from 'vitest';
import { createModalRouter, type ModalRouterDeps } from './modal-router';
import type { ModalState } from './modal-types';

/** Minimal in-memory host: tracks the modal signal plus the pdf / preview
 *  side-channels the router writes to. */
function makeHost() {
  let modal: ModalState = null;
  let pdfPath: string | null = null;
  let previewPath: string | null = null;
  const deps: ModalRouterDeps = {
    modal: () => modal,
    setModal: (next) => {
      modal = next;
    },
    setPdfPath: (next) => {
      pdfPath = next;
    },
    setPreviewPath: (next) => {
      previewPath = next;
    },
  };
  return {
    deps,
    modal: () => modal,
    pdfPath: () => pdfPath,
    previewPath: () => previewPath,
  };
}

const state = (path: string, title?: string): NonNullable<ModalState> => ({ path, title });

describe('createModalRouter', () => {
  it('opens directly when no modal is shown', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    expect(host.modal()).toEqual({ path: '/a.md', title: 'A' });
  });

  it('pushes the current modal and fills backLabel from its title', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    router.navigateInModal(state('/b.md', 'B'));
    expect(host.modal()).toEqual({ path: '/b.md', title: 'B', backLabel: 'A' });
  });

  it('falls back to the path basename for an untitled previous modal', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/dir/a.md'));
    router.navigateInModal(state('/b.md', 'B'));
    expect(host.modal()?.backLabel).toBe('a.md');
  });

  it('keeps an explicit backLabel on the next state', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    router.navigateInModal({ ...state('/b.md', 'B'), backLabel: 'custom' });
    expect(host.modal()?.backLabel).toBe('custom');
  });

  it('back pops one entry at a time, restoring the previous state', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    router.navigateInModal(state('/b.md', 'B'));
    router.navigateInModal(state('/c.md', 'C'));
    expect(host.modal()?.path).toBe('/c.md');
    router.handleModalBack();
    expect(host.modal()).toEqual({ path: '/b.md', title: 'B', backLabel: 'A' });
    router.handleModalBack();
    expect(host.modal()).toEqual({ path: '/a.md', title: 'A' });
  });

  it('back on an empty stack closes the modal', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    router.handleModalBack();
    expect(host.modal()).toBeNull();
  });

  it('back on an empty stack restores a pending preview', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.setPreviewBackPath('/project/readme');
    router.navigateInModal(state('/a.md', 'A'));
    router.handleModalBack();
    expect(host.modal()).toBeNull();
    expect(host.previewPath()).toBe('/project/readme');
    expect(router.previewBackPath()).toBeNull();
  });

  it('close wipes the whole stack — a reopened modal has no history', () => {
    const host = makeHost();
    const router = createModalRouter(host.deps);
    router.navigateInModal(state('/a.md', 'A'));
    router.navigateInModal(state('/b.md', 'B'));
    router.closeChildModal(() => host.deps.setModal(null));
    expect(host.modal()).toBeNull();
    // Reopen and go back: the old chain must not resurface.
    router.navigateInModal(state('/c.md', 'C'));
    router.handleModalBack();
    expect(host.modal()).toBeNull();
  });
});
