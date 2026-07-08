import { createEffect, createSignal } from 'solid-js';
import type { OpenWithSlots, TerminalPrefs } from '@shared/types';
import { getBootstrap } from '../bootstrap';

export interface UseConfigBindingsDeps {
  conceptionPath: () => string | null;
}

export interface UseConfigBindings {
  openWithSlots: () => OpenWithSlots;
  terminalPrefs: () => TerminalPrefs | undefined;
  reloadConfig: () => Promise<void>;
}

/** Open With slots + terminal prefs are config-bound — they change only
 *  on a `'config'` tree event (or an explicit user save). Plain signals
 *  keep them out of the Suspense/resource graph so a knowledge edit
 *  doesn't refetch them. */
export function useConfigBindings(deps: UseConfigBindingsDeps): UseConfigBindings {
  const [openWithSlots, setOpenWithSlots] = createSignal<OpenWithSlots>({});
  const [terminalPrefs, setTerminalPrefs] = createSignal<TerminalPrefs | undefined>(undefined);

  const reloadConfig = async (): Promise<void> => {
    if (!deps.conceptionPath()) {
      setOpenWithSlots({});
      setTerminalPrefs(undefined);
      return;
    }
    const [slots, prefs] = await Promise.all([
      window.condash.listOpenWith(),
      window.condash.termGetPrefs(),
    ]);
    setOpenWithSlots(slots);
    setTerminalPrefs(prefs);
  };

  // Hydrate for a given conception. The one-shot boot bundle already carries the
  // open-with slots + terminal prefs for the initial conception, so seed from it
  // instead of a second listOpenWith + termGetPrefs round-trip (S6); a later
  // conception switch (cp differs from the boot path) falls through to a fresh
  // fetch. The `deps.conceptionPath() === cp` re-check guards against a
  // conception switch landing while the (memoized, usually-resolved) bootstrap
  // promise was awaited.
  const hydrateConfig = async (cp: string): Promise<void> => {
    const boot = await getBootstrap();
    if (cp === boot.conceptionPath) {
      if (deps.conceptionPath() !== cp) return;
      setOpenWithSlots(boot.openWith);
      setTerminalPrefs(boot.terminalPrefs);
      return;
    }
    await reloadConfig();
  };

  // Reload on every conception-path change. Mirrors the per-store effect
  // so the three config-bound reads stay in sync without a shared
  // refreshKey.
  createEffect(() => {
    const cp = deps.conceptionPath();
    if (!cp) {
      setOpenWithSlots({});
      setTerminalPrefs(undefined);
      return;
    }
    void hydrateConfig(cp);
  });

  return { openWithSlots, terminalPrefs, reloadConfig };
}
