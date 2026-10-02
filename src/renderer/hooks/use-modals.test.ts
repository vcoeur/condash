import { describe, expect, it } from 'vitest';
import { useModals } from './use-modals';

describe('utility overlay ownership', () => {
  it('has one singleton owner and a display-only height mask', () => {
    const modals = useModals();
    for (const kind of ['automations', 'logs', 'diagnostics'] as const) {
      modals.setActiveModal({ kind });
      expect(modals.activeModal()).toEqual({ kind });
      expect(modals.heightModalOpen()).toBe(true);
      modals.setSearchModalOpen(true);
      expect(modals.activeModal()).toEqual({ kind: 'search' });
    }
    modals.setActiveModal(null);
    expect(modals.heightModalOpen()).toBe(false);
  });

  it('keeps dirty ownership until the discard decision and ignores duplicate transitions', async () => {
    const modals = useModals();
    modals.setActiveModal({ kind: 'automations' });
    let resolve!: (allowed: boolean) => void;
    modals.registerLeaveGuard(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    modals.setSettingsOpen(true);
    modals.setActiveModal({ kind: 'logs' });
    expect(modals.activeModal()).toEqual({ kind: 'automations' });
    resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(modals.activeModal()).toEqual({ kind: 'automations' });
    const switchAllowed = modals.withConceptionChange(async () => {});
    resolve(true);
    expect(await switchAllowed).toBe(true);
    expect(modals.activeModal()).toBeNull();
    modals.registerLeaveGuard(null);
    modals.setActiveModal({ kind: 'diagnostics' });
    expect(modals.activeModal()).toEqual({ kind: 'diagnostics' });
  });

  it('owns the switch operation until completion and excludes launches and overlapping switches', async () => {
    const modals = useModals();
    let finish!: () => void;
    const changing = modals.withConceptionChange(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect(modals.transitionPending()).toBe(true);
    modals.setActiveModal({ kind: 'automations' });
    expect(modals.activeModal()).toBeNull();
    expect(
      await modals.withConceptionChange(async () => {
        throw new Error('overlap must not run');
      }),
    ).toBe(false);
    finish();
    expect(await changing).toBe(true);
    expect(modals.transitionPending()).toBe(false);
    modals.setActiveModal({ kind: 'logs' });
    expect(modals.activeModal()).toEqual({ kind: 'logs' });
  });

  it('releases switch ownership when its operation fails', async () => {
    const modals = useModals();
    await expect(
      modals.withConceptionChange(async () => {
        throw new Error('fixture failure');
      }),
    ).rejects.toThrow('fixture failure');
    expect(modals.transitionPending()).toBe(false);
    modals.setSettingsOpen(true);
    expect(modals.settingsOpen()).toBe(true);
  });
});
