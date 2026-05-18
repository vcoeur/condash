import { createEffect, createSignal } from 'solid-js';
import type { OpenWithSlots, TerminalPrefs } from '@shared/types';

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

  // Reload on every conception-path change. Mirrors the per-store effect
  // so the three config-bound reads stay in sync without a shared
  // refreshKey.
  createEffect(() => {
    if (!deps.conceptionPath()) {
      setOpenWithSlots({});
      setTerminalPrefs(undefined);
      return;
    }
    void reloadConfig();
  });

  return { openWithSlots, terminalPrefs, reloadConfig };
}
