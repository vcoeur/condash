import type { AgentListItem } from '@shared/harnesses';
import type { ActionTemplate, Project, RepoEntry, TerminalPrefs, Worktree } from '@shared/types';
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
  /** Read the agents defined under `<conception>/agents/` (for action
   *  templates that bind to a specific agent via `action.agent`). */
  agents: () => readonly AgentListItem[];
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
  /** Run a Tasks-pane task: spawn a fresh tab running the agent with `agentSlug`,
   *  type the already-substituted `text`, and press Enter when `submit` is true.
   *  Same spawn-and-type path as an agent-bound project action. */
  runTask: (agentSlug: string, text: string, submit: boolean) => Promise<void>;
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

/** Look up an agent by slug from the current agent list. Returns null for an
 *  empty/missing slug or when no agent matches. */
function findAgentBySlug(
  agents: readonly AgentListItem[],
  slug: string | undefined,
): AgentListItem | null {
  if (!slug) return null;
  return agents.find((a) => a.slug === slug) ?? null;
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

  /** Spawn a fresh tab running `agent` and settle. Two-step settle:
   *  (1) reconcile needs at least one tick to receive the onTermSessions
   *  snapshot, attach the xterm, and set the new tab as active;
   *  (2) the agent process itself (e.g. `claude`, `kimi`) needs time to print
   *  its prompt before it will accept typed input — typing during init drops
   *  characters or lands in a not-yet-ready REPL. AGENT_SPAWN_SETTLE_MS covers
   *  both. setTimeout (not requestAnimationFrame) so this stays callable in
   *  unit tests (jsdom env has no rAF).
   *
   *  When `initialPrompt` is set, it passes the prompt as a CLI argument to the
   *  agent harness (claude: positional arg; opencode: `--prompt`). The settle
   *  delay is skipped in that case — the prompt is in argv, not typed via pty. */
  const spawnAgentTab = async (
    agent: AgentListItem,
    initialPrompt?: string,
  ): Promise<TerminalPaneHandle | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    try {
      await handle.spawnUserShell(agent, 'my', initialPrompt);
    } catch (err) {
      deps.flashToast(`Could not spawn ${agent.name}: ${(err as Error).message}`, 'error');
      return null;
    }
    if (!initialPrompt) {
      await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
    }
    return handle;
  };

  /** Action-aware preamble: when the action binds an agent (`action.agent`,
   *  one of the agents under `<conception>/agents/`), spawn a fresh tab
   *  running that agent on every click — keeps "Start new project →
   *  claude-deepseek-v4-pro" predictable instead of typing into whatever tab
   *  happens to be focused. Falls back to `ensureTermAndShell()` (a plain
   *  shell) when no agent is bound or the bound slug no longer resolves. */
  const ensureTermForAction = async (
    action: ActionTemplate,
  ): Promise<TerminalPaneHandle | null> => {
    const agent = findAgentBySlug(deps.agents(), action.agent);
    if (!agent) return ensureTermAndShell();
    return spawnAgentTab(agent);
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
    const handle = await ensureTermForAction(action);
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
    const handle = await ensureTermForAction(action);
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

  /** Harnesses whose CLI accepts an initial prompt as an argument, removing
   *  the need to type into the pty after spawn. */
  const NATIVE_INITIAL_PROMPT_HARNESSES = new Set(['claude', 'opencode']);

  const runTask = async (agentSlug: string, text: string, submit: boolean): Promise<void> => {
    const agent = findAgentBySlug(deps.agents(), agentSlug);
    if (!agent) {
      deps.flashToast(`Task agent not found: ${agentSlug}`, 'error');
      return;
    }

    // When the harness supports it and submit is true, pass the prompt as a
    // CLI argument in argv. The agent executes it on startup — no pty.write,
    // no settle delay, no race.
    if (submit && NATIVE_INITIAL_PROMPT_HARNESSES.has(agent.harness)) {
      const handle = await spawnAgentTab(agent, text);
      if (!handle) return;
      return;
    }

    const handle = await spawnAgentTab(agent);
    if (!handle) return;
    // Kimi has no CLI flag for an initial prompt in interactive mode, so we
    // must still type via the pty. Replace the blind 350 ms settle delay
    // (built into spawnAgentTab) with a prompt-marker watch so we never
    // send text before kimi is ready to read it.
    if (agent.harness === 'kimi') {
      const sessionId = handle.getActiveSessionId();
      if (sessionId) {
        try {
          await handle.waitForReady(sessionId, /▸/);
        } catch {
          // Timeout — fall through and type anyway (best-effort).
        }
      }
    }
    handle.typeIntoActive(text);
    if (submit) {
      // Small delay so the terminal has time to ingest the typed text
      // before the Enter key arrives.
      await new Promise((r) => setTimeout(r, 50));
      handle.typeIntoActive('\r');
    }
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
