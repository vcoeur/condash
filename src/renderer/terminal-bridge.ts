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
import { linkProject } from './link-store';
import type { TerminalPaneHandle } from './terminal-pane';

export interface TerminalBridgeDeps {
  /** Read the current terminal pane handle (null until the pane is mounted). */
  terminalHandle: () => TerminalPaneHandle | null;
  /** Open the terminal pane if it isn't already (visual-only; the pane stays
   *  mounted whenever a session exists). */
  ensureTerminalOpen: () => void;
  /** Flip the bottom band to the terminal body (and open the pane) — the
   *  focus-linked-tab path, because `ensureTerminalOpen` alone can leave the
   *  Dashboard body up. */
  showTerminalBand: () => void;
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
   *  exists, so the action never silently no-ops. Does not press Enter.
   *  Always links that tab to the project (see `linkProject`): a persisted
   *  relation that outlives a reload and dies with the tab. */
  handleWorkOn: (project: Project) => Promise<void>;
  /** Execute a configured project action — substitute template, type into
   *  the focused terminal, and press Enter when `submit` is true. When the
   *  action sets `link`, also links the tab it typed into to the project —
   *  the freshly spawned one for an `agent`-bound action. */
  handleProjectAction: (project: Project, action: ActionTemplate) => Promise<void>;
  /** Execute a configured "+ New project" starter action — substitute
   *  global template, type into the focused terminal, and press Enter
   *  when `submit` is true. */
  handleNewProjectAction: (action: ActionTemplate) => Promise<void>;
  /** Open a project-scoped shell in the pane at the given worktree. */
  handleOpenInTerm: (repo: RepoEntry, worktree: Worktree) => Promise<void>;
  /** Focus the terminal tab with session `sid` from a card's linked-tab row:
   *  `switchTo('my', sid)` (a no-op when the tab died meanwhile — prune has
   *  already cleared the row), then open the pane and flip the band to the
   *  terminal body. Never "Work on", which types into the focused tab instead
   *  of targeting a specific one. */
  handleFocusLinkedTab: (sid: string) => Promise<void>;
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
  runShellCommand: (command: string, title?: string) => Promise<boolean>;
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
 *  Covers two races: the renderer's onTermSessions reconcile (the tab must
 *  reach the roster before anything is delivered to it) and the agent
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

/** The tab an action landed on: the pane handle plus the session id of the tab
 *  that receives the text. Callers need the id — not just the handle — to write
 *  the tab↔project link, and the id has to come from the spawn that created
 *  the tab rather than be read back off the handle afterwards. */
interface ActionTarget {
  handle: TerminalPaneHandle;
  sid: string;
}

/** Poll cadence and ceiling for {@link focusSpawnedTab}. The ceiling only ever
 *  elapses when the tab genuinely never arrives; the wait returns the moment it
 *  does. Generous because the first tab of a cold app pays for the dynamic
 *  xterm import, which can outlast any flat settle. */
const SPAWN_WAIT_POLL_MS = 50;
const SPAWN_WAIT_MAX_MS = 3000;

/** Wait for a freshly spawned `sid` to join the tab roster, then make it the
 *  active tab.
 *
 *  A spawn resolves as soon as main has the pty, but the tab reaches the
 *  renderer only on the next reconcile pass — which inserts it into the roster,
 *  then awaits a dynamic xterm import, and only afterwards activates it. The
 *  two things an action does need the same guarantee across that window —
 *  roster membership. The link needs it or a pass still holding a pre-spawn
 *  snapshot prunes the relation; `typeInto` needs it or there is no tab to
 *  deliver to. Activation is a third thing, and it is for the user's eyes:
 *  the tab they are about to work in should be the one on screen.
 *
 *  Polling for "active" would cover both, but it can also never arrive:
 *  activation is last-writer-wins within a pass, so a tab inserted in the same
 *  tick takes it. So poll the monotone condition — membership — and then
 *  activate the tab outright instead of waiting to see whether it happens.
 *  `switchTo` no-ops on an id it does not know, which is why membership has to
 *  come first.
 *
 *  Bounded, non-throwing, and honest about failing: false means the tab never
 *  arrived and focus was left where it was. The caller must not type then — the
 *  text would land in whatever tab the user was looking at, and a `submit`
 *  action would run it there. */
async function focusSpawnedTab(handle: TerminalPaneHandle, sid: string): Promise<boolean> {
  // A spawn that answered with no id has nothing to wait for — without this the
  // caller would sit out the whole ceiling before carrying on.
  if (!sid) return false;
  const steps = Math.ceil(SPAWN_WAIT_MAX_MS / SPAWN_WAIT_POLL_MS);
  for (let i = 0; i < steps; i++) {
    if (handle.sessionLabel(sid) !== null) {
      handle.switchTo('my', sid);
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SPAWN_WAIT_POLL_MS));
  }
  return false;
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

  /** Deliver `text` to the tab `target` names, pressing Enter after it when
   *  `submit`. The single delivery path for every action, and the one place a
   *  failed delivery is reported — a call site cannot forget to, which is the
   *  mistake this whole class of defect keeps being made of.
   *
   *  The band flip and `switchTo` are for the user: together they put the tab
   *  they are about to work in on screen. It is not what makes the delivery correct; `typeInto` is, because
   *  it addresses the sid rather than whatever is active. That distinction
   *  matters because there is no window in which the renderer promises to
   *  leave focus alone: `focusSpawnedTab` returns the moment the spawned tab
   *  joins the roster, while the reconcile pass that inserted it is still
   *  suspended in its dynamic xterm import, and when that pass resumes it can
   *  insert *and activate* another session from the same snapshot. Every
   *  `await` here — and every `await` a caller takes between the focus step and
   *  this call — is such a window. Re-activating the tab before each keystroke
   *  would only narrow them.
   *
   *  A write fails once the tab it names stops being live: a clean exit closes
   *  the row, an abnormal one keeps it with a dead pty — so the toast says "no
   *  longer live" rather than "closed", which is only half of it. The two
   *  writes report separately, because a command typed but never submitted is a
   *  different thing to explain than one that never arrived.
   *
   *  Reports the two writes separately because callers want different ones.
   *  `delivered` — the text reached the tab — is what decides whether the tab is
   *  working on the project, and so whether to link it: a refused Enter does not
   *  retract that, the prompt is sitting there either way. `submitted` is true
   *  when no Enter was asked for, or when it landed; a caller that exists to
   *  *run* something needs that one, not the first. */
  const sendToTarget = async (
    target: ActionTarget,
    text: string,
    submit: boolean,
  ): Promise<{ delivered: boolean; submitted: boolean }> => {
    // Only when it is not already the active tab. `switchTo` has no
    // already-active guard, and `setActiveIn` allocates a fresh signal object,
    // so a redundant call refires the focus effect and chains a whole
    // visibility pass — against a tab reconcile has just queued a repaint for.
    // Both paths in here usually arrive already active: `focusSpawnedTab`
    // switched a microtask ago, and the reuse path returns the active sid by
    // construction.
    if (target.handle.activeLiveSessionId() !== target.sid) {
      target.handle.switchTo('my', target.sid);
    }
    if (!target.handle.typeInto(target.sid, text)) {
      deps.flashToast('That terminal tab is no longer live — nothing was sent.', 'error');
      return { delivered: false, submitted: false };
    }
    // The other half of "put the tab on screen": `switchTo` only sets the
    // active id and column, and with the bottom band showing the Dashboard body
    // every xterm is display:none — so without this the text is delivered
    // correctly to a tab the user cannot see, which, now that these surfaces
    // wait seconds and disable themselves while they do, reads as a hang. After
    // the write, not before, so a refused delivery does not rearrange the
    // layout on its way to saying it failed.
    deps.showTerminalBand();
    if (!submit) return { delivered: true, submitted: true };
    // Small delay so the terminal has time to ingest the typed text before the
    // Enter key arrives.
    await new Promise((r) => setTimeout(r, 50));
    if (!target.handle.typeInto(target.sid, '\r')) {
      deps.flashToast(
        'That terminal tab is no longer live — the command was not submitted.',
        'error',
      );
      return { delivered: true, submitted: false };
    }
    return { delivered: true, submitted: true };
  };

  /** Shared preamble: ensure the pane is open, and hand back a tab that can be
   *  written to — spawning a shell when there is none live.
   *
   *  Deliberately NOT deduplicated across concurrent callers. Two callers
   *  arriving while a spawn is in flight do each open a shell, and that looked
   *  like a defect worth fixing until the fix was tried: sharing one tab makes
   *  two submit-bearing actions interleave on the same prompt line, so the
   *  shell runs the two commands concatenated. A second tab is a surprise; a
   *  concatenated command is a wrong command.
   *
   *  Racing is held off at the surfaces instead, where the intent is known,
   *  rather than here, where two callers wanting one tab and two callers
   *  wanting two are indistinguishable. The Resources pane blocks every card
   *  while a paste is in flight and the Install button blocks itself; the
   *  Work-on and project-action buttons do not, so a double-click there does
   *  open two tabs. Pre-existing, and named here so the absence reads as known
   *  rather than as covered. */
  const ensureTermAndShell = async (): Promise<ActionTarget | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    const live = handle.activeLiveSessionId();
    if (live) return { handle, sid: live };
    try {
      // Keep the id the spawn returns. A fresh tab only becomes the active
      // one on the next reconcile pass, so reading the active id back off
      // the handle here can still answer with the tab that just left.
      const sid = await handle.spawnUserShell(null, 'my');
      // Both steps, the same pair `spawnAgentTab` takes: the settle is for
      // the shell to finish init and start accepting input (typing during it
      // drops leading characters); the focus step is what puts the tab in
      // front of the user and confirms the roster holds it.
      await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
      if (!(await focusSpawnedTab(handle, sid))) {
        deps.flashToast('The new terminal tab did not open in time — nothing was sent.', 'error');
        return null;
      }
      return { handle, sid };
    } catch (err) {
      deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
      return null;
    }
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
    /** False when the prompt rides in argv, so nothing will be typed into this
     *  tab afterwards. Changes what a focus failure means: the agent is running
     *  either way, so there is no lost text to report and no reason to hand the
     *  caller a null it would read as "the action did not happen". */
    deliversText = true,
  ): Promise<ActionTarget | null> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) return null;
    deps.ensureTerminalOpen();
    let sid: string;
    try {
      // Keep the call shape minimal: bare 2-arg for an untitled spawn, 3-arg
      // when a title is set, and only widen to 4-arg when a task context must
      // ride along (capability 4). Preserves the shapes existing callers
      // assert on.
      if (taskContext !== undefined) {
        sid = await handle.spawnUserShell(agent, 'my', title, taskContext);
      } else if (title === undefined) {
        sid = await handle.spawnUserShell(agent, 'my');
      } else {
        sid = await handle.spawnUserShell(agent, 'my', title);
      }
    } catch (err) {
      deps.flashToast(`Could not spawn ${agent.label}: ${(err as Error).message}`, 'error');
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
    // The settle above is for the launched program's prompt, not for reconcile,
    // and a cold app's first tab can outlast it. This is what guarantees the
    // prompt is typed into the tab the agent runs in and not the one that held
    // focus when the action fired.
    if (!(await focusSpawnedTab(handle, sid))) {
      if (deliversText) {
        deps.flashToast(`${agent.label}'s tab did not open in time — nothing was sent.`, 'error');
        return null;
      }
      // The prompt went in on the command line, so the agent is running with it
      // whether or not its tab reached the renderer in time. Saying "nothing
      // was sent" would be false, and returning null would drop the link to the
      // tab that is doing the work.
      deps.flashToast(`${agent.label} is running, but its tab was slow to open.`, 'info');
    }
    // A freshly spawned tab is one the user should be looking at, and switching
    // to it does not by itself bring the terminal body up. `sendToTarget` does
    // this too, for the deliveries that go through it — but an agent that takes
    // its prompt in argv never gets there.
    deps.showTerminalBand();
    return { handle, sid };
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
  ): Promise<ActionTarget | null> => {
    if (agent.promptFlags) {
      const flag = mode === 'oneshot' ? '--run' : '--prompt';
      const command = `${agent.command} ${flag} ${quoteForShell(text, promptShellFamily())}`;
      return spawnAgentTab({ ...agent, command }, title, taskContext, false);
    }
    const target = await spawnAgentTab(agent, title, taskContext);
    if (!target) return null;
    // A tab that took none of the prompt is not a tab the action landed in —
    // callers use this return to link the project to it. A prompt that was
    // typed but not submitted still landed there, and still counts.
    if (!(await sendToTarget(target, text, submit)).delivered) return null;
    return target;
  };

  /** Write the tab↔project relation the card's Link button writes, naming the
   *  tab as the tab strip does. Idempotent: the store no-ops when the pair
   *  already exists.
   *
   *  A null label means the tab is not in the roster — the spawn's `sid` never
   *  showed up, or answered empty. That is exactly when the relation must NOT
   *  be written: the reconcile prune runs against the roster, so it would
   *  delete the record moments later. Silent rather than a toast: whatever the
   *  action itself did, it did. */
  const linkTargetToProject = (target: ActionTarget, project: Project): void => {
    const label = target.handle.sessionLabel(target.sid);
    if (!label) return;
    linkProject(project.slug, target.sid, label);
  };

  const handleWorkOn = async (project: Project): Promise<void> => {
    const text = `work on ${project.slug}`;
    const target = await ensureTermAndShell();
    if (!target) return;
    // The built-in row links unconditionally and carries no flag: starting
    // work on a project is exactly the moment its tab belongs to it — but only
    // if the work actually got there. Linking after a "nothing was sent" toast
    // records a relation to a tab the user was just told failed.
    if (!(await sendToTarget(target, text, false)).delivered) return;
    linkTargetToProject(target, project);
  };

  const handleProjectAction = async (project: Project, action: ActionTemplate): Promise<void> => {
    const ctx = projectContext(project, deps.conceptionPath() ?? undefined);
    const text = substitute(action.template, ctx);
    // When the action binds an agent, spawn a fresh tab running it (seeding the
    // prompt via flags when the agent opts in). Otherwise type into the focused
    // tab, spawning a plain shell only if none exists.
    const agent = findAgentById(deps.agents(), action.agent);
    if (agent) {
      const spawned = await runAgentTask(agent, text, action.submit === true);
      // An agent-bound action links the tab the agent runs in, not the one
      // that held focus at click time — that is where the work happens.
      if (spawned && action.link) linkTargetToProject(spawned, project);
      return;
    }
    const target = await ensureTermAndShell();
    if (!target) return;
    if (!(await sendToTarget(target, text, action.submit === true)).delivered) return;
    if (action.link) linkTargetToProject(target, project);
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
    const target = await ensureTermAndShell();
    if (!target) return;
    await sendToTarget(target, text, action.submit === true);
  };

  /** Focus a linked terminal tab from a card row's arrow. `switchTo` is the
   *  exposed jump-to-tab primitive and no-ops when the tab died meanwhile
   *  (prune has already cleared the row by then); the band flip is what makes
   *  the focus visible — `ensureTerminalOpen` alone would leave the Dashboard
   *  body up. Deliberately not the "open a shell if none active" dance: the
   *  tab being focused exists, and this action must never spawn one. */
  const handleFocusLinkedTab = async (sid: string): Promise<void> => {
    const handle = deps.terminalHandle();
    if (!handle) return;
    handle.switchTo('my', sid);
    deps.ensureTerminalOpen();
    deps.showTerminalBand();
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
    // The last write in this module that used to address "whatever is active".
    // It reads as the one case that genuinely means that — but the shortcut can
    // be pressed while a reconcile pass is activating a restored session, and
    // the path then lands in that tab. So it names the tab it means.
    //
    // Deliberately NOT the "spawn a shell if none is live" preamble the two
    // clicked surfaces take: this is a key-repeat-capable shortcut with no
    // debounce, and holding it on an empty pane would open a tab per repeat.
    // Nothing to paste into stays nothing pasted, as before.
    const handle = deps.terminalHandle();
    if (!handle) return;
    const sid = handle.activeLiveSessionId();
    if (!sid) {
      // Every other surface here explains a refused delivery; this one used to
      // drop in silence, which on a dead-but-still-shown tab looks like the
      // shortcut is broken. Scoped to the active column, which is what
      // `activeLiveSessionId` answers about — the other column may well hold a
      // live shell, and claiming there is none would be wrong.
      deps.flashToast('The active terminal tab is not live — nothing was pasted.', 'error');
      return;
    }
    await sendToTarget({ handle, sid }, latest, false);
  };

  const handlePasteToTerm = async (text: string): Promise<void> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    if (!deps.terminalHandle()) {
      deps.flashToast('Terminal pane not available.', 'error');
      return;
    }
    // The same preamble every project action takes, rather than a second copy
    // of spawn-then-type: on an empty pane it spawns the shell and waits for
    // its tab to reach the renderer. Typing on the line after the spawn
    // instead dropped the path outright — the spawn resolves as soon as main
    // has the pty, and there is no tab to write to until a reconcile pass
    // later.
    // `ensureTermAndShell` toasts for every failure it can hit here — a spawn
    // that threw, a tab that never opened — and the guard above owns the
    // missing handle, so a null needs no second explanation.
    const target = await ensureTermAndShell();
    if (!target) return;
    await sendToTarget(target, text, false);
  };

  const runShellCommand = async (command: string, title?: string): Promise<boolean> => {
    if (!deps.terminalHandle()) {
      deps.ensureTerminalOpen();
      await waitForTerminalHandle(deps);
    }
    const handle = deps.terminalHandle();
    if (!handle) {
      deps.flashToast('Terminal pane not available.', 'error');
      return false;
    }
    deps.ensureTerminalOpen();
    let sid: string;
    try {
      // Always a fresh plain-shell tab — never reuse the focused tab (which
      // could be a running agent). null agent + a pinned title. The id it
      // answers with is how the tab is named below; reading the active id back
      // off the handle would still answer with the tab that just left.
      sid = await handle.spawnUserShell(null, 'my', title);
    } catch (err) {
      deps.flashToast(`Could not open a shell: ${(err as Error).message}`, 'error');
      return false;
    }
    // Both steps, the same pair every agent spawn takes: the settle is for the
    // shell to finish init and start accepting input; the focus step is what
    // confirms the tab exists to be written to. The settle alone was a hope —
    // on a cold app whose first dynamic xterm import outlasts it the command
    // was typed into nothing and silently lost. It also ends in Enter, so a
    // tab that did not open must stop the command rather than let it run in
    // whatever tab held focus.
    await new Promise<void>((resolve) => setTimeout(resolve, AGENT_SPAWN_SETTLE_MS));
    if (!(await focusSpawnedTab(handle, sid))) {
      deps.flashToast('The new terminal tab did not open in time — nothing was sent.', 'error');
      return false;
    }
    // This one exists to run the command, not merely to place it — a prompt
    // left unsubmitted is not a command that ran, and the caller schedules work
    // off this answer.
    const sent = await sendToTarget({ handle, sid }, command, true);
    return sent.delivered && sent.submitted;
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
    handleFocusLinkedTab,
    handleScreenshotPaste,
    handlePasteToTerm,
    runShellCommand,
    runTask,
  };
}
