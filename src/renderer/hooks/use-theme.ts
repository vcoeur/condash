import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Theme } from '@shared/types';
import { resetMermaidTheme } from '../markdown';
import { refreshAllXtermThemes } from '../xterm-registry';

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

export interface UseThemeDeps {
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseTheme {
  theme: () => Theme;
  setTheme: (next: Theme) => void;
  isDark: () => boolean;
  /** UI-only theme update for the Settings modal callback. The modal
   *  persists via patchSettings / patchConfig — calling setTheme here
   *  would queue a second write that races the modal's CAS baseline. */
  handleThemeChange: (next: Theme) => void;
}

export function useTheme(deps: UseThemeDeps): UseTheme {
  const [theme, setTheme] = createSignal<Theme>('system');

  // Resolved dark/light flag for the active app theme. Watches `theme()`
  // plus the system colour-scheme media query so a system flip while the
  // app is open propagates to CodeMirror's theme compartment.
  const [systemDark, setSystemDark] = createSignal(
    typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    onCleanup(() => mq.removeEventListener('change', onChange));
  }

  const isDark = createMemo(() => {
    const t = theme();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return systemDark();
  });

  // Repaint live xterms whenever isDark flips. Covers both the user-driven
  // toggle (already handled in handleThemeChange) and the system flip while
  // theme='system'. Runs once on mount with the initial value — harmless,
  // since CSS tokens already match.
  createEffect(() => {
    isDark();
    refreshAllXtermThemes();
  });

  void window.condash
    .getTheme()
    .then((t) => {
      setTheme(t);
      applyTheme(t);
    })
    .catch((err) => deps.flashToast(`Could not load theme: ${(err as Error).message}`, 'error'));

  const handleThemeChange = (next: Theme): void => {
    setTheme(next);
    applyTheme(next);
    resetMermaidTheme();
    // xterm refresh runs through the createEffect on isDark above.
  };

  return { theme, setTheme, isDark, handleThemeChange };
}
