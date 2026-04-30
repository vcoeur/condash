import type { Project, RepoEntry, TerminalPrefs, Worktree } from '@shared/types';
import type { TerminalPaneHandle } from './terminal-pane';

export interface TerminalBridgeDeps {
  /** Read the current terminal pane handle (null until the pane is mounted). */
  terminalHandle: () => TerminalPaneHandle | null;
  /** Open the terminal pane if it isn't already (visual-only; the pane stays
   *  mounted whenever a session exists). */
  ensureTerminalOpen: () => void;
  /** Read terminal preferences (for screenshot dir + launcher command). */
  terminalPrefs: () => TerminalPrefs | undefined;
  /** Surface a transient toast in the renderer. */
  flashToast: (msg: string) => void;
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
        await handle.spawnUserShell(deps.terminalPrefs()?.launcher_command ?? null, 'my');
      } catch (err) {
        deps.flashToast(`Could not open a shell: ${(err as Error).message}`);
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
      await handle.spawn(
        {
          side: 'my',
          cwd: worktree.path,
        },
        label,
      );
    } catch (err) {
      deps.flashToast(`Open in term failed: ${(err as Error).message}`);
    }
  };

  const handleScreenshotPaste = async (): Promise<void> => {
    const prefs = deps.terminalPrefs() ?? {};
    const dir = prefs.screenshot_dir;
    if (!dir) {
      deps.flashToast('No terminal.screenshot_dir set in configuration.json');
      return;
    }
    const latest = await window.condash.termLatestScreenshot(dir);
    if (!latest) {
      deps.flashToast(`No files under ${dir}`);
      return;
    }
    const handle = deps.terminalHandle();
    if (!handle) return;
    handle.typeIntoActive(latest);
  };

  return { handleWorkOn, handleOpenInTerm, handleScreenshotPaste };
}
