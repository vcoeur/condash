import type {
  Agent,
  ActionTemplate,
  Project,
  RepoEntry,
  RunMode,
  TaskRunContext,
  TerminalPrefs,
  Worktree,
} from '@shared/types';
import { globalContext, projectContext, substitute } from '@shared/action-template';
import { quoteForShell, shellFamily, type ShellFamily } from '@shared/shell-quote';
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
  /** Open the terminal pane, spawn a fresh user-shell tab, and run `command`
   *  (typed + Enter). Used by the status-bar "Install skills" action to run
   *  `condash skills install` visibly in its own tab. */
  runShellCommand: (command: string, title?: string) => Promise<void>;
  /** Run a Tasks-pane task: spawn a fresh tab running the agent with `agentId`
   *  and deliver the already-substituted `text`. The tab title is pinned to
   *  `<agent label>•<taskName>`. A `promptFlags` agent is seeded via the run's
   *  `runMode` — `--prompt` (interactive, session stays open) or `--run`
   *  (one-shot, exits when done); an opaque agent is spawned bare, then the
   *  prompt is keystroke-injected and submitted once the TUI settles. When
   *  `opts` requests it, the run's log is routed to `.condash/manual/<slug>/`
   *  instead of the normal logs (capability 4). */
  runTask: (
    agentId: string,
    text: string,
    taskName: string,
    opts?: { taskSlug: string; excludeFromLogs: boolean; runMode: RunMode },
  ) => Promise<void>;
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

/** Renderer-side Windows detection (no `process` in a sandboxed renderer).
 *  Only consulted when no `terminal.shell` is configured — a configured shell
 *  names its own family by basename. */
function isWindowsRenderer(): boolean {
  return typeof navigator !== 'undefined' && /^win/i.test(navigator.platform ?? '');
}

/** Bridges between dashboard actions (per-card work-on, open-in-term,
 *  screenshot paste) and the terminal pane. Centralises the "spawn a
 *  shell first if there isn't one" dance so callers don't repeat it. */
export function createTerminalBridge(deps: TerminalBridgeDeps): TerminalBridge {
  /** Family of the shell the main process will wrap a spawned command with
   *  (`terminals.ts` resolves the same `terminal.shell` pref through the same
   *  shared detection) — prompt quoting must match it, or `&` / `|` / `%VAR%`
   *  in a prompt execute under cmd.exe / pwsh. */
  const promptShellFamily = (): ShellFamily =>
    shellFamily(deps.terminalPrefs()?.shell, isWindowsRenderer());

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
    taskContext?: TaskRunContext,
  ): Promise<TerminalPaneHandle | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    try {
      // Keep the call shape minimal: bare 2-arg for an untitled spawn, 3-arg
      // when a title is set, and only widen to 4-arg when a task context must
      // ride along (capability 4). Preserves the shapes existing callers
      // assert on.
      if (taskContext !== undefined) {
        await handle.spawnUserShell(agent, 'my', title, taskContext);
      } else if (title === undefined) {
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

  /** Run `text` through `agent` in a fresh tab. For a `promptFlags` agent, `mode`
   *  picks how the prompt is delivered in argv: `interactive` seeds it via
   *  `--prompt` and the session stays open for follow-ups; `oneshot` uses `--run`,
   *  which runs the prompt once and exits (the tab closes when the agent is done).
   *  Either way the prompt is delivered at launch, so nothing is typed. For an
   *  opaque agent (no `promptFlags`) the prompt is keystroke-injected into the
   *  live TUI (always interactive — `mode` is moot there); `submit` adds the Enter
   *  keystroke. Project / new-project actions default to `interactive`; a task run
   *  passes the task's chosen mode. */
  const runAgentTask = async (
    agent: Agent,
    text: string,
    submit: boolean,
    title?: string,
    taskContext?: TaskRunContext,
    mode: RunMode = 'interactive',
  ): Promise<void> => {
    if (agent.promptFlags) {
      const flag = mode === 'oneshot' ? '--run' : '--prompt';
      const command = `${agent.command} ${flag} ${quoteForShell(text, promptShellFamily())}`;
      await spawnAgentTab({ ...agent, command }, title, taskContext);
      return;
    }
    const handle = await spawnAgentTab(agent, title, taskContext);
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

  const runShellCommand = async (command: string, title?: string): Promise<void> => {
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
    try {
      // Always a fresh plain-shell tab — never reuse the focused tab (which
      // could be a running agent). null agent + a pinned title.
      await handle.spawnUserShell(null, 'my', title);
    } catch (err) {
      deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
      return;
    }
    // Same settle as an agent spawn: let the reconcile mark the new tab active
    // and the shell print its prompt before typing.
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
    handle.typeIntoActive(command);
    await new Promise((r) => setTimeout(r, 50));
    handle.typeIntoActive('\r');
  };

  const runTask = async (
    agentId: string,
    text: string,
    taskName: string,
    opts?: { taskSlug: string; excludeFromLogs: boolean; runMode: RunMode },
  ): Promise<void> => {
    const agent = findAgentById(deps.agents(), agentId);
    if (!agent) {
      deps.flashToast(`Task agent not found: ${agentId}`, 'error');
      return;
    }
    // A manual task run that opts out of the normal logs carries a task
    // context so the SessionLogger routes its `.txt` to
    // `.condash/manual/<slug>/` (capability 4). Without the flag the run logs
    // normally, as today.
    const taskContext: TaskRunContext | undefined =
      opts?.excludeFromLogs && opts.taskSlug
        ? { taskSlug: opts.taskSlug, trigger: 'manual' }
        : undefined;
    // Same spawn-and-deliver path as an agent-bound project action. `submit: true`
    // presses Enter on the opaque keystroke path; a promptFlags agent is seeded via
    // the task's chosen mode (`--run` one-shot or `--prompt` interactive). The tab
    // is named `<agent label>•<task title>` so a running task is spotted at a glance.
    await runAgentTask(
      agent,
      text,
      true,
      `${agent.label}•${taskName}`,
      taskContext,
      opts?.runMode ?? 'interactive',
    );
  };

  return {
    handleWorkOn,
    handleProjectAction,
    handleNewProjectAction,
    handleOpenInTerm,
    handleScreenshotPaste,
    handlePasteToTerm,
    runShellCommand,
    runTask,
  };
}
