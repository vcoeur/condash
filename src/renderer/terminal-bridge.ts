import type {
  Agent,
  ActionTemplate,
  Project,
  RepoEntry,
  TerminalPrefs,
  Worktree,
} from '@shared/types';
import { globalContext, projectContext, substitute } from '@shared/action-template';
import type { TerminalPaneHandle } from './terminal-pane';

export interface TerminalBridgeDeps {
  /** Read the current terminal pane handle (null until the pane is mounted). */
  terminalHandle: () => TerminalPaneHandle | null;
  /** Open the terminal pane if it isn't already (visual-only; the pane stays
   *  mounted whenever a session exists). */
  ensureTerminalOpen: () => void;
  /** Read terminal preferences (for the screenshot directory). */
  terminalPrefs: () => TerminalPrefs | undefined;
  /** Read the configured agents (the `agents` settings list), for action
   *  templates that bind to a specific agent via `action.agent`. */
  agents: () => readonly Agent[];
  /** Surface a transient toast in the renderer. */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
  /** Current conception path for global-context substitution. */
  conceptionPath: () => string | null;
}

export interface TerminalBridge {
  /** Per-card "work on" — paste "work on <slug>" into the focused
   *  terminal. Opens the pane and spawns a shell first if neither
   *  exists, so the action never silently no-ops. Does not press Enter. */
  handleWorkOn: (project: Project) => Promise<void>;
  /** Execute a configured project action — substitute template, type into
   *  the focused terminal, and press Enter when `submit` is true. */
  handleProjectAction: (project: Project, action: ActionTemplate) => Promise<void>;
  /** Execute a configured "+ New project" starter action — substitute
   *  global template, type into the focused terminal, and press Enter
   *  when `submit` is true. */
  handleNewProjectAction: (action: ActionTemplate) => Promise<void>;
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
  /** Run a Tasks-pane task: spawn a fresh tab running the agent with `agentId`
   *  and deliver the already-substituted `text`. The tab title is pinned to
   *  `<agent label>•<taskName>`. Tasks always launch interactively — a
   *  `promptFlags` agent is seeded with `--prompt` (the session stays open after
   *  the prompt runs); an opaque agent is spawned bare, then the prompt is
   *  keystroke-injected and submitted once the TUI settles. */
  runTask: (agentId: string, text: string, taskName: string) => Promise<void>;
}

/** Upper bound on animation frames waited for the pane to mount after
 *  `ensureTerminalOpen()`. At ~60 Hz this is ~200 ms — comfortably more
 *  than a Solid render pass yet still tight enough to surface a genuine
 *  mount failure as a no-op rather than an indefinite hang. */
const HANDLE_WAIT_FRAMES = 12;

/** Delay between spawning an agent-bound tab and typing the template into it.
 *  Covers two races: the renderer's onTermSessions reconcile (must run before
 *  the new tab becomes the active typeIntoActive target) and the agent
 *  process's own boot time (claude / kimi need to print their prompt before
 *  accepting input). 350 ms is the smallest value that didn't drop characters
 *  across the agents we've tried; imperceptible to a user clicking a menu
 *  item. */
const AGENT_SPAWN_SETTLE_MS = 350;

/** Wait until `deps.terminalHandle()` returns non-null, or the frame cap
 *  expires. The previous `queueMicrotask` spin (single microtask) was just
 *  shy of an actual paint and intermittently returned before the Solid
 *  effect that registered the handle had run. */
async function waitForTerminalHandle(deps: TerminalBridgeDeps): Promise<TerminalPaneHandle | null> {
  for (let i = 0; i < HANDLE_WAIT_FRAMES; i++) {
    const handle = deps.terminalHandle();
    if (handle) return handle;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return deps.terminalHandle();
}

/** Look up an agent by id from the current agent list. Returns null for an
 *  empty/missing id or when no agent matches. */
function findAgentById(agents: readonly Agent[], id: string | undefined): Agent | null {
  if (!id) return null;
  return agents.find((a) => a.id === id) ?? null;
}

/** POSIX single-quote `text` so it survives `bash -lc "<command>"` as a single
 *  argument: wrap in single quotes and rewrite each embedded `'` as `'\''`
 *  (close-quote, escaped quote, reopen-quote). */
function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Bridges between dashboard actions (per-card work-on, open-in-term,
 *  screenshot paste) and the terminal pane. Centralises the "spawn a
 *  shell first if there isn't one" dance so callers don't repeat it. */
export function createTerminalBridge(deps: TerminalBridgeDeps): TerminalBridge {
  /** Shared preamble: ensure pane is open, spawn a shell if none active. */
  const ensureTermAndShell = async (): Promise<TerminalPaneHandle | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    if (!handle.hasActive()) {
      try {
        await handle.spawnUserShell(null, 'my');
      } catch (err) {
        deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
        return null;
      }
    }
    return handle;
  };

  /** Spawn a fresh tab running `agent`'s command and settle. Two-step settle:
   *  (1) reconcile needs at least one tick to receive the onTermSessions
   *  snapshot, attach the xterm, and set the new tab as active;
   *  (2) the launched command (e.g. an interactive REPL) may need time to print
   *  its prompt before it will accept typed input — typing during init drops
   *  characters or lands in a not-yet-ready REPL. AGENT_SPAWN_SETTLE_MS covers
   *  both. setTimeout (not requestAnimationFrame) so this stays callable in
   *  unit tests (jsdom env has no rAF). */
  const spawnAgentTab = async (
    agent: Agent,
    title?: string,
  ): Promise<TerminalPaneHandle | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    try {
      // Pass the title only when set so the non-task spawn keeps the agent's
      // own label (and the 2-arg call shape its callers assert on).
      if (title === undefined) {
        await handle.spawnUserShell(agent, 'my');
      } else {
        await handle.spawnUserShell(agent, 'my', title);
      }
    } catch (err) {
      deps.flashToast(`Could not spawn ${agent.label}: ${(err as Error).message}`, 'error');
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
    return handle;
  };

  /** Run `text` through `agent` in a fresh tab, always interactively so the
   *  session stays open after the prompt runs (a one-shot `--run` would exit and
   *  tear the tab down). When the agent opts into agedum prompt flags
   *  (`promptFlags`), seed the prompt via `--prompt` in argv and spawn that; the
   *  prompt is delivered at launch, so nothing is typed. Otherwise spawn the bare
   *  command, let the TUI settle, and keystroke-inject `text` (plus Enter when
   *  `submit`) — the generic path for an opaque agent. `submit` only governs that
   *  keystroke Enter; a `promptFlags` agent is always seeded interactively. */
  const runAgentTask = async (
    agent: Agent,
    text: string,
    submit: boolean,
    title?: string,
  ): Promise<void> => {
    if (agent.promptFlags) {
      const command = `${agent.command} --prompt ${shellSingleQuote(text)}`;
      await spawnAgentTab({ ...agent, command }, title);
      return;
    }
    const handle = await spawnAgentTab(agent, title);
    if (!handle) return;
    handle.typeIntoActive(text);
    if (submit) {
      // Small delay so the terminal has time to ingest the typed text
      // before the Enter key arrives.
      await new Promise((r) => setTimeout(r, 50));
      handle.typeIntoActive('\r');
    }
  };

  const handleWorkOn = async (project: Project): Promise<void> => {
    const text = `work on ${project.slug}`;
    const handle = await ensureTermAndShell();
    if (!handle) return;
    handle.typeIntoActive(text);
  };

  const handleProjectAction = async (project: Project, action: ActionTemplate): Promise<void> => {
    const ctx = projectContext(project, deps.conceptionPath() ?? undefined);
    const text = substitute(action.template, ctx);
    // When the action binds an agent, spawn a fresh tab running it (seeding the
    // prompt via flags when the agent opts in). Otherwise type into the focused
    // tab, spawning a plain shell only if none exists.
    const agent = findAgentById(deps.agents(), action.agent);
    if (agent) {
      await runAgentTask(agent, text, action.submit === true);
      return;
    }
    const handle = await ensureTermAndShell();
    if (!handle) return;
    handle.typeIntoActive(text);
    if (action.submit) {
      // Small delay so the terminal has time to ingest the typed text
      // before the Enter key arrives.
      await new Promise((r) => setTimeout(r, 50));
      handle.typeIntoActive('\r');
    }
  };

  const handleNewProjectAction = async (action: ActionTemplate): Promise<void> => {
    const today = new Date().toISOString().slice(0, 10);
    const ctx = globalContext(today, deps.conceptionPath() ?? '');
    const text = substitute(action.template, ctx);
    const agent = findAgentById(deps.agents(), action.agent);
    if (agent) {
      await runAgentTask(agent, text, action.submit === true);
      return;
    }
    const handle = await ensureTermAndShell();
    if (!handle) return;
    handle.typeIntoActive(text);
    if (action.submit) {
      await new Promise((r) => setTimeout(r, 50));
      handle.typeIntoActive('\r');
    }
  };

  const handleOpenInTerm = async (repo: RepoEntry, worktree: Worktree): Promise<void> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
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
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) {
      deps.flashToast('Terminal pane not available.', 'error');
      return;
    }
    deps.ensureTerminalOpen();
    if (!handle.hasActive()) {
      try {
        await handle.spawnUserShell(null, 'my');
      } catch (err) {
        deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
        return;
      }
    }
    handle.typeIntoActive(text);
  };

  const runTask = async (agentId: string, text: string, taskName: string): Promise<void> => {
    const agent = findAgentById(deps.agents(), agentId);
    if (!agent) {
      deps.flashToast(`Task agent not found: ${agentId}`, 'error');
      return;
    }
    // Same interactive spawn-and-deliver path as an agent-bound project action.
    // `submit: true` presses Enter on the opaque keystroke path; a promptFlags
    // agent is seeded with `--prompt` (interactive) regardless. The tab is named
    // `<agent label>•<task title>` so a running task is identifiable at a glance.
    await runAgentTask(agent, text, true, `${agent.label}•${taskName}`);
  };

  return {
    handleWorkOn,
    handleProjectAction,
    handleNewProjectAction,
    handleOpenInTerm,
    handleScreenshotPaste,
    handlePasteToTerm,
    runTask,
  };
}
