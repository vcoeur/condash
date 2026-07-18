import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { Theme } from '@shared/types';
import { resolveThemePreset } from '@shared/themes';
import { resetMermaidTheme } from '../markdown';
import { refreshAllXtermThemes } from '../xterm-registry';
import { getBootstrap } from '../bootstrap';

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

  // Live OS colour-scheme preference. Only `system` reads it, but it has to
  // stay live: a system flip while the app is open must repaint.
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

  // The resolved preset drives both the DOM attributes and `isDark`, so the
  // CSS and the JS-side consumers (CodeMirror, xterm, mermaid) can never
  // disagree about which theme is showing.
  const preset = createMemo(() => resolveThemePreset(theme(), systemDark()));
  const isDark = createMemo(() => preset().kind === 'dark');

  // Push the resolved preset onto `<html>` as two attributes:
  //
  // - `data-theme` — the preset id, selecting the palette block in styles.css.
  //   Always set, including under `system`: the OS preference is resolved here
  //   in JS rather than left to a `@media` arm, so exactly one selector paints
  //   and a third preset can't be outranked by the OS block's specificity.
  // - `data-theme-kind` — `dark` or `light`. Everything that only cares whether
  //   the surface is dark keys on this (hljs, app pills, the settings modal,
  //   the dashboard pane), so a new dark preset needs no new selectors. It also
  //   fixes those rules under `system`: they used to key on `[data-theme=dark]`,
  //   which `system` never set, so a dark-OS user on the default theme got
  //   light app-pill and code-block colours.
  //
  // One effect covers every path — the explicit pick, the bootstrap hydration,
  // and an OS flip under `system` — because all three feed `preset()`.
  createEffect(() => {
    const active = preset();
    const root = document.documentElement;
    root.setAttribute('data-theme', active.id);
    root.setAttribute('data-theme-kind', active.kind);
  });

  // Repaint live xterms whenever the dark/light flag flips. Runs once on mount
  // with the initial value — harmless, since CSS tokens already match.
  createEffect(() => {
    isDark();
    refreshAllXtermThemes();
  });

  void getBootstrap()
    .then((boot) => setTheme(boot.theme))
    .catch((err) => deps.flashToast(`Could not load theme: ${(err as Error).message}`, 'error'));

  const handleThemeChange = (next: Theme): void => {
    setTheme(next);
    // The DOM attributes and the xterm repaint both ride the effects above;
    // only mermaid needs an explicit nudge (its theme is baked at init).
    resetMermaidTheme();
  };

  return { theme, setTheme, isDark, handleThemeChange };
}
