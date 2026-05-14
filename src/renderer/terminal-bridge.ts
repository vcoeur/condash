import type { LauncherConfig, Project, RepoEntry, TerminalPrefs, Worktree } from '@shared/types';
import type { TerminalPaneHandle } from './terminal-pane';

/** Pick the default launcher used when the dashboard auto-spawns a shell
 *  (per-card "work on", paste-to-term). Returns the first configured entry
 *  with a non-empty command, or `null` when none exist — callers spawn a
 *  plain shell in that case. */
function defaultLauncher(prefs: TerminalPrefs | undefined): LauncherConfig | null {
  const launchers = prefs?.launchers ?? [];
  return launchers.find((l) => l.command.trim().length > 0) ?? null;
}

export interface TerminalBridgeDeps {
  /** Read the current terminal pane handle (null until the pane is mounted). */
  terminalHandle: () => TerminalPaneHandle | null;
  /** Open the terminal pane if it isn't already (visual-only; the pane stays
   *  mounted whenever a session exists). */
  ensureTerminalOpen: () => void;
  /** Read terminal preferences (for screenshot dir + launcher command). */
  terminalPrefs: () => TerminalPrefs | undefined;
  /** Surface a transient toast in the renderer. */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface TerminalBridge {
  /** Per-card "work on" — paste "work on <slug>" into the focused
   *  terminal. Opens the pane and spawns a shell first if neither
   *  exists, so the action never silently no-ops. Does not press Enter. */
  handleWorkOn: (project: Project) => Promise<void>;
  /** Open a project-scoped shell in the pane at the given worktree. */
  handleOpenInTerm: (repo: RepoEntry, worktree: Worktree) => Promise<void>;
  /** Paste the most recent screenshot path (under `screenshot_dir`) into
   *  the active terminal. Triggered by the configured shortcut. */
  handleScreenshotPaste: () => Promise<void>;
  /** Paste an arbitrary text fragment (typically a file path) into the
   *  focused terminal session. Used by the Resources pane's
   *  "Paste path → Term" button — re-uses the same "open pane, spawn
   *  shell if needed" dance as `handleWorkOn`. Does not press Enter. */
  handlePasteToTerm: (text: string) => Promise<void>;
}

/** Bridges between dashboard actions (per-card work-on, open-in-term,
 *  screenshot paste) and the terminal pane. Centralises the "spawn a
 *  shell first if there isn't one" dance so callers don't repeat it. */
export function createTerminalBridge(deps: TerminalBridgeDeps): TerminalBridge {
  const handleWorkOn = async (project: Project): Promise<void> => {
    const text = `work on ${project.slug}`;
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }
    const handle = deps.terminalHandle();
    if (!handle) return;
    deps.ensureTerminalOpen();
    if (!handle.hasActive()) {
      try {
        await handle.spawnUserShell(defaultLauncher(deps.terminalPrefs()), 'my');
      } catch (err) {
        deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
        return;
      }
    }
    handle.typeIntoActive(text);
  };

  const handleOpenInTerm = async (repo: RepoEntry, worktree: Worktree): Promise<void> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }
    const handle = deps.terminalHandle();
    if (!handle) return;
    deps.ensureTerminalOpen();
    const branchSuffix = worktree.branch ? `· ${worktree.branch}` : '';
    const label = `${repo.name}${branchSuffix ? ` ${branchSuffix}` : ''}`;
    try {
      // No `repo`/`command` → spawns the user's default shell at the worktree
      // path inside the existing terminal pane (no popup window).
      // `pinned`: keep the `<repo> · <branch>` label as the tab title even
      // after the shell emits OSC 7 (which would otherwise replace it with
      // the worktree basename and hide the branch).
      await handle.spawn(
        {
          side: 'my',
          cwd: worktree.path,
        },
        label,
        { pinned: true },
      );
    } catch (err) {
      deps.flashToast(`Open in term failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleScreenshotPaste = async (): Promise<void> => {
    const prefs = deps.terminalPrefs() ?? {};
    const dir = prefs.screenshot_dir;
    if (!dir) {
      deps.flashToast(
        'No screenshot directory set — open Settings → Terminal → Screenshot directory.',
        'error',
      );
      return;
    }
    const latest = await window.condash.termLatestScreenshot(dir);
    if (!latest) {
      deps.flashToast(`No files under ${dir}`, 'error');
      return;
    }
    const handle = deps.terminalHandle();
    if (!handle) return;
    handle.typeIntoActive(latest);
  };

  const handlePasteToTerm = async (text: string): Promise<void> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }
    const handle = deps.terminalHandle();
    if (!handle) {
      deps.flashToast('Terminal pane not available.', 'error');
      return;
    }
    deps.ensureTerminalOpen();
    if (!handle.hasActive()) {
      try {
        await handle.spawnUserShell(defaultLauncher(deps.terminalPrefs()), 'my');
      } catch (err) {
        deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
        return;
      }
    }
    handle.typeIntoActive(text);
  };

  return { handleWorkOn, handleOpenInTerm, handleScreenshotPaste, handlePasteToTerm };
}
