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
  /** The **committed** choice. A transient preview never moves this, so
   *  everything that reasons about what the user has actually chosen — the
   *  Settings picker's checked card, its keyboard tab stop, `globalTheme()`'s
   *  fallback — can read it without following the pointer around. */
  theme: () => Theme;
  setTheme: (next: Theme) => void;
  isDark: () => boolean;
  /** UI-only theme update for the Settings modal callback. The modal
   *  persists via patchSettings / patchConfig — calling setTheme here
   *  would queue a second write that races the modal's CAS baseline. */
  handleThemeChange: (next: Theme) => void;
  /**
   * Overlay a theme on the running UI without committing it — the Settings
   * picker's hover preview. Pass `null` to drop the overlay and fall back to
   * the committed theme.
   *
   * A separate signal rather than a temporary `setTheme`, because a preview has
   * to reach the JS-side consumers (xterm, CodeMirror, mermaid) *without*
   * becoming the answer to "what is selected?". Routing it through the
   * committed signal made the hovered card render as checked and made the
   * restore target move while previewing; clearing an overlay needs no captured
   * target at all, so it also can't race a Save.
   */
  previewTheme: (next: Theme | null) => void;
}

export function useTheme(deps: UseThemeDeps): UseTheme {
  const [theme, setTheme] = createSignal<Theme>('system');
  const [previewed, setPreviewed] = createSignal<Theme | null>(null);

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
  // disagree about which theme is showing. The preview overlay wins while it is
  // set — that is the whole point of it — but only here, at the render layer.
  const preset = createMemo(() => resolveThemePreset(previewed() ?? theme(), systemDark()));
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

  // Re-theme the JS-side consumers on every preset change — tracking the
  // *preset*, not `isDark()`. xterm reads its colours out of the computed CSS
  // tokens (`themeFromCss` in xterm-mount.ts) and only re-reads on refresh, and
  // mermaid bakes its theme at init; a dark→dark switch (Warm Gallery ↔
  // Console) changes every one of those tokens while the boolean stays `true`,
  // so keying on `isDark()` let the memo swallow the change and left open
  // terminals painting the old theme's background inside the new theme's panel.
  // Sits here rather than in `handleThemeChange` so the preview overlay gets
  // the same treatment as a committed change. Runs once on mount — harmless,
  // the tokens already match.
  createEffect(() => {
    preset();
    refreshAllXtermThemes();
    resetMermaidTheme();
  });

  void getBootstrap()
    .then((boot) => setTheme(boot.theme))
    .catch((err) => deps.flashToast(`Could not load theme: ${(err as Error).message}`, 'error'));

  const handleThemeChange = (next: Theme): void => {
    // Committing supersedes any overlay: without this, saving from inside the
    // picker would leave the preview sitting on top of the new choice.
    setPreviewed(null);
    setTheme(next);
  };

  const previewTheme = (next: Theme | null): void => {
    setPreviewed(next);
  };

  return { theme, setTheme, isDark, handleThemeChange, previewTheme };
}
