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
   * Overlay a theme on the running UI without committing it — how the Settings
   * picker shows an unsaved selection. Pass `null` to drop the overlay and fall
   * back to the committed theme.
   *
   * A separate signal rather than a temporary `setTheme`, because a preview has
   * to reach the JS-side consumers (xterm, CodeMirror) *without* becoming the
   * answer to "what is selected?" — routing it through the committed signal
   * made the previewed card render as checked, since the modal reads that
   * signal back. The picker owns this overlay's whole lifecycle and drops it on
   * unmount, so a cancelled edit cannot leave it stranded.
   */
  previewTheme: (next: Theme | null) => void;
  /** Commit a theme **and persist it**. The status-bar cycle's entry point —
   *  unlike `handleThemeChange`, which leaves persistence to the Settings
   *  modal's own write. */
  cycleTheme: (next: Theme) => void;
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
  // tokens (`themeFromCss` in xterm-mount.ts) and only re-reads on refresh, so a
  // dark→dark switch (Warm Gallery ↔ Console) changes every one of those tokens
  // while the boolean stays `true`; keying on `isDark()` let the memo swallow
  // the change and left open terminals painting the old theme's background
  // inside the new theme's panel. Sits here rather than in `handleThemeChange`
  // so the preview overlay gets the same treatment as a committed change. Runs
  // once on mount — harmless, the tokens already match.
  //
  // `resetMermaidTheme()` only drops the cached engine so the *next* render
  // picks up the new palette — already-rendered SVGs keep their old colours
  // either way (pre-existing, and true on the committed path too). It is not a
  // repaint.
  createEffect(() => {
    preset();
    refreshAllXtermThemes();
    resetMermaidTheme();
  });

  void getBootstrap()
    .then((boot) => setTheme(boot.theme))
    .catch((err) => deps.flashToast(`Could not load theme: ${(err as Error).message}`, 'error'));

  // Deliberately does NOT clear the overlay. The picker owns the overlay's whole
  // lifecycle (set from its selection, dropped on unmount), so clearing it here
  // would drop a live preview that nothing re-asserts — the picker's effect
  // tracks its own selection and would not re-run. While a preview is up it is
  // what the user is looking at, and it outranks a commit underneath it; the
  // commit becomes visible the moment the picker goes away.
  const handleThemeChange = (next: Theme): void => {
    setTheme(next);
  };

  const previewTheme = (next: Theme | null): void => {
    setPreviewed(next);
  };

  // The status-bar cycle has no modal behind it to persist the choice, so it
  // writes settings.json itself. `handleThemeChange` deliberately does not: the
  // Settings modal owns its own write, and a second one from here would race
  // its compare-and-set baseline. (The cycle silently lost its choice on
  // restart before this — pre-existing on main, surfaced by review here.)
  let cycleSeq = 0;
  const cycleTheme = (next: Theme): void => {
    const seq = ++cycleSeq;
    handleThemeChange(next);
    void window.condash.setTheme(next).catch(async (err) => {
      // Optimistic UI with rollback on IPC failure, per the repo convention.
      // Without it a failed write leaves the app painted in a theme that is not
      // on disk: the toast reads as spurious because the change visibly
      // happened, and the next launch silently reverts it.
      deps.flashToast(`Could not save theme: ${(err as Error).message}`, 'error');

      // Only the newest cycle may roll back, and only if nothing has moved the
      // theme since. Two fast clicks whose writes settle out of order would
      // otherwise let a stale rejection stomp a newer choice that did reach
      // disk — recreating the desync this rollback exists to prevent.
      if (seq !== cycleSeq || theme() !== next) return;

      // Re-read the file rather than restoring a locally-remembered value.
      // `theme()` may hold an optimistic value from an earlier failed cycle, and
      // a renderer-side "last confirmed" anchor goes stale the moment the
      // Settings modal saves a theme through its own write path — rolling back
      // to either one restores something that is not what is on disk. The file
      // is the only authority, whoever last wrote it.
      try {
        const onDisk = await window.condash.getTheme();
        if (seq === cycleSeq && theme() === next) handleThemeChange(onDisk);
      } catch {
        // Both the write and the read failed: settings IPC is down entirely.
        // Leave the optimistic value rather than guessing — there is nothing
        // better to fall back to, and the toast has already said so.
      }
    });
  };

  return { theme, setTheme, isDark, handleThemeChange, previewTheme, cycleTheme };
}
