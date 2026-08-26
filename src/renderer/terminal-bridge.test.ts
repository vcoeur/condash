import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalBridge } from './terminal-bridge';
import { linkedTabsOf, unlinkAllForTab } from './link-store';
import type { TerminalPaneHandle } from './terminal-pane';
import type { Agent, ActionTemplate, Project, TerminalPrefs } from '@shared/types';

type FakeHandle = {
  spawn: ReturnType<typeof vi.fn>;
  switchTo: ReturnType<typeof vi.fn>;
  spawnUserShell: ReturnType<typeof vi.fn>;
  moveActiveTab: ReturnType<typeof vi.fn>;
  typeIntoActive: ReturnType<typeof vi.fn>;
  hasActive: ReturnType<typeof vi.fn>;
  getActiveSessionId: ReturnType<typeof vi.fn>;
  sessionLabel: ReturnType<typeof vi.fn>;
  /** Display name per sid — the roster `sessionLabel` reads. A sid absent here
   *  is a tab the renderer has not inserted yet. */
  labels: Record<string, string>;
  /** Every `typeIntoActive` call with the sid that was active when it ran, so a
   *  test can assert *which* tab the text reached, not just that it was typed. */
  typedInto: { sid: string | null; text: string }[];
};

/** The id every fake spawn answers with. */
const SPAWNED_SID = 'session-new';
/** A spawn id the roster never learns about — the tab that never opens. */
const NEVER_ARRIVES_SID = 'never-arrives';

function makeFakeHandle(): FakeHandle {
  // Modelled on what reconcile actually does, and deliberately in two separate
  // steps: a spawn puts the tab in the roster under the name `spawnUserShell`
  // would give it, and NOTHING activates it. Activation is `switchTo`'s job —
  // which is the distinction the bridge turns on, so the double has to make it
  // observable rather than collapse the two into one assignment.
  let activeId: string | null = 'session-1';
  const handle: FakeHandle = {
    spawn: vi.fn().mockResolvedValue(''),
    switchTo: vi.fn((_side: string, id?: string) => {
      // No-ops on a tab the roster does not hold, exactly as the controller's
      // does — that is what makes "poll for membership, then switch" ordering
      // load-bearing, so the double has to enforce it too.
      if (id && handle.labels[id] !== undefined) activeId = id;
    }),
    spawnUserShell: vi.fn(async (agent?: Agent | null, _side?: string, titleOverride?: string) => {
      handle.labels[SPAWNED_SID] = titleOverride ?? agent?.label ?? 'shell';
      return SPAWNED_SID;
    }),
    moveActiveTab: vi.fn(),
    typeIntoActive: vi.fn((text: string) => {
      handle.typedInto.push({ sid: activeId, text });
    }),
    hasActive: vi.fn().mockReturnValue(true),
    getActiveSessionId: vi.fn(() => activeId),
    sessionLabel: vi.fn((sid: string) => handle.labels[sid] ?? null),
    labels: { 'session-1': 'conception · main' },
    typedInto: [],
  };
  return handle;
}

// The link store is a module singleton, so relations written by one test would
// otherwise be visible to the next. Both sids the fakes hand out get cleared.
afterEach(() => {
  unlinkAllForTab('session-1');
  unlinkAllForTab(SPAWNED_SID);
  unlinkAllForTab(NEVER_ARRIVES_SID);
  // A test that fails mid-body never reaches its own `vi.useRealTimers()`, and
  // fake timers left armed hang every test after it — which reads as a second
  // failure in an unrelated case. Reset here so one red test stays one.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeDeps(handle: FakeHandle | null = null, agents: Agent[] = []) {
  return {
    terminalHandle: () => handle as unknown as TerminalPaneHandle | null,
    ensureTerminalOpen: vi.fn(),
    showTerminalBand: vi.fn(),
    terminalPrefs: (): TerminalPrefs => ({}),
    agents: () => agents,
    flashToast: vi.fn(),
    conceptionPath: () => '/home/alice/src/vcoeur/conception',
  };
}

const claudeAgent: Agent = {
  id: 'claude-deepseek-v4-pro',
  label: 'DeepSeek v4 Pro',
  command: 'claude',
};
const kimiAgent: Agent = {
  id: 'kimi-cli-native',
  label: 'Kimi native',
  command: 'kimi --agent-file ~/.kimi/global-agent.yaml',
};
const agedumAgent: Agent = {
  id: 'agedum-claude',
  label: 'agedum · claude',
  command: 'agedum claude',
  promptFlags: true,
};

const sampleProject: Project = {
  slug: '2026-05-17-foo-bar',
  title: 'Foo Bar',
  kind: 'project',
  status: 'now',
  apps: ['condash'],
  path: '/home/alice/src/vcoeur/conception/projects/2026-05/2026-05-17-foo-bar',
  branch: 'feat-foo',
  base: 'main',
  parent: null,
  steps: [],
  stepCounts: { todo: 0, doing: 0, done: 0, blocked: 0, dropped: 0 },
  deliverables: [],
  deliverableCount: 0,
  closedAt: null,
  timeline: [],
};

describe('handleWorkOn', () => {
  it('types "work on <slug>" into the active terminal', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleWorkOn(sampleProject);
    expect(handle.typeIntoActive).toHaveBeenCalledWith('work on 2026-05-17-foo-bar');
  });

  it('opens the pane and spawns a shell when none is active', async () => {
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    await bridge.handleWorkOn(sampleProject);
    expect(deps.ensureTerminalOpen).toHaveBeenCalled();
    expect(handle.spawnUserShell).toHaveBeenCalled();
    expect(handle.typeIntoActive).toHaveBeenCalledWith('work on 2026-05-17-foo-bar');
  });
});

describe('handleProjectAction', () => {
  it('substitutes template and types the result without Enter when submit is false', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const action: ActionTemplate = {
      label: 'Review',
      template: 'claude "review {shortSlug}"',
      submit: false,
    };
    await bridge.handleProjectAction(sampleProject, action);
    expect(handle.typeIntoActive).toHaveBeenCalledWith('claude "review foo-bar"');
    expect(handle.typeIntoActive).toHaveBeenCalledTimes(1);
  });

  it('substitutes template, types it, and presses Enter when submit is true', async () => {
    const handle = makeFakeHandle();
    vi.useFakeTimers();
    const bridge = createTerminalBridge(makeDeps(handle));
    const action: ActionTemplate = {
      label: 'Review',
      template: 'claude "review {shortSlug}"',
      submit: true,
    };
    const promise = bridge.handleProjectAction(sampleProject, action);
    await vi.advanceTimersByTimeAsync(60);
    await promise;
    expect(handle.typeIntoActive).toHaveBeenCalledWith('claude "review foo-bar"');
    expect(handle.typeIntoActive).toHaveBeenLastCalledWith('\r');
    expect(handle.typeIntoActive).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('shows an error toast when spawning a shell fails', async () => {
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    handle.spawnUserShell.mockRejectedValue(new Error('No shell'));
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    await bridge.handleProjectAction(sampleProject, { label: 'X', template: 'x' });
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('Could not open a shell'),
      'error',
    );
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
  });
});

describe('handleNewProjectAction', () => {
  it('substitutes global template and types without Enter when submit is false', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const action: ActionTemplate = {
      label: 'Spec starter',
      template: 'start project for {today}:',
      submit: false,
    };
    await bridge.handleNewProjectAction(action);
    expect(handle.typeIntoActive).toHaveBeenCalledTimes(1);
    const call = vi.mocked(handle.typeIntoActive).mock.calls[0][0];
    expect(call).toMatch(/^start project for \d{4}-\d{2}-\d{2}:$/);
  });

  it('types and presses Enter when submit is true', async () => {
    const handle = makeFakeHandle();
    vi.useFakeTimers();
    const bridge = createTerminalBridge(makeDeps(handle));
    const action: ActionTemplate = {
      label: 'Spec starter',
      template: 'draft {conception}',
      submit: true,
    };
    const promise = bridge.handleNewProjectAction(action);
    await vi.advanceTimersByTimeAsync(60);
    await promise;
    expect(handle.typeIntoActive).toHaveBeenCalledWith('draft conception');
    expect(handle.typeIntoActive).toHaveBeenLastCalledWith('\r');
    expect(handle.typeIntoActive).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('spawns the bound agent and types into the new tab when action.agent is set', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent, kimiAgent]));
    const action: ActionTemplate = {
      label: 'Start new project',
      template: 'Start new project ',
      agent: 'kimi-cli-native',
    };
    const promise = bridge.handleNewProjectAction(action);
    // Drain the agent-spawn settle delay (~350 ms).
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(kimiAgent, 'my');
    expect(handle.typeIntoActive).toHaveBeenCalledWith('Start new project ');
    vi.useRealTimers();
  });

  it('falls back to the focused-tab flow when action.agent matches no agent', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent]));
    const action: ActionTemplate = {
      label: 'Start new project',
      template: 'Start new project ',
      agent: 'nonexistent',
    };
    await bridge.handleNewProjectAction(action);
    // No spawn — handle is already active, fell through to the default flow.
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
    expect(handle.typeIntoActive).toHaveBeenCalledWith('Start new project ');
  });
});

describe('handleProjectAction with agent binding', () => {
  it('spawns the bound agent before typing the substituted template', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent]));
    const action: ActionTemplate = {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'claude-deepseek-v4-pro',
    };
    const promise = bridge.handleProjectAction(sampleProject, action);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(claudeAgent, 'my');
    expect(handle.typeIntoActive).toHaveBeenCalledWith('review foo-bar');
    vi.useRealTimers();
  });

  it('seeds the prompt via flags when the bound agent opts in', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const action: ActionTemplate = {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'agedum-claude',
      submit: true,
    };
    const promise = bridge.handleProjectAction(sampleProject, action);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'review foo-bar'" },
      'my',
    );
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('runTask', () => {
  it('spawns an opaque agent, settles, types via pty, and submits', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [kimiAgent]));
    const promise = bridge.runTask('kimi-cli-native', 'review the docs', 'Review docs');
    await vi.advanceTimersByTimeAsync(600);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(kimiAgent, 'my', 'Kimi native•Review docs');
    expect(handle.typeIntoActive).toHaveBeenCalledWith('review the docs');
    expect(handle.typeIntoActive).toHaveBeenLastCalledWith('\r');
    vi.useRealTimers();
  });

  it('toasts and does nothing when the agent is unknown', async () => {
    const handle = makeFakeHandle();
    const deps = makeDeps(handle, [claudeAgent]);
    const bridge = createTerminalBridge(deps);
    await bridge.runTask('does-not-exist', 'text', 'Some task');
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('Task agent not found'),
      'error',
    );
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
  });
});

describe('runTask with promptFlags agent', () => {
  it('seeds `<command> --prompt <quoted>` interactively and does not type', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.runTask('agedum-claude', 'review the docs', 'Review docs');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'review the docs'" },
      'my',
      'agedum · claude•Review docs',
    );
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('single-quotes a prompt containing quotes and special chars', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.runTask('agedum-claude', "it's a $PATH; rm -rf", 'Risky run');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'it'\\''s a $PATH; rm -rf'" },
      'my',
      'agedum · claude•Risky run',
    );
    vi.useRealTimers();
  });

  it('quotes for the configured shell family — pwsh gets PowerShell quoting', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const deps = {
      ...makeDeps(handle, [agedumAgent]),
      terminalPrefs: (): TerminalPrefs => ({ shell: 'pwsh' }),
    };
    const bridge = createTerminalBridge(deps);
    const promise = bridge.runTask('agedum-claude', "it's a & b | %PATH%", 'Win run');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'it''s a & b | %PATH%'" },
      'my',
      'agedum · claude•Win run',
    );
    vi.useRealTimers();
  });

  it('quotes for cmd.exe — &, |, and %VAR% are caret-escaped, not executable', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const deps = {
      ...makeDeps(handle, [agedumAgent]),
      terminalPrefs: (): TerminalPrefs => ({ shell: 'cmd.exe' }),
    };
    const bridge = createTerminalBridge(deps);
    const promise = bridge.runTask('agedum-claude', 'a & b | %PATH%', 'Cmd run');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: 'agedum claude --prompt ^"a ^& b ^| ^%PATH^%^"' },
      'my',
      'agedum · claude•Cmd run',
    );
    vi.useRealTimers();
  });

  it('seeds `--run` (one-shot) when the run opts request oneshot mode', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.runTask('agedum-claude', 'review the docs', 'Review docs', {
      taskSlug: 'review-docs',
      excludeFromLogs: false,
      runMode: 'oneshot',
    });
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --run 'review the docs'" },
      'my',
      'agedum · claude•Review docs',
    );
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('seeds `--prompt` when the run opts request interactive mode', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.runTask('agedum-claude', 'review the docs', 'Review docs', {
      taskSlug: 'review-docs',
      excludeFromLogs: false,
      runMode: 'interactive',
    });
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'review the docs'" },
      'my',
      'agedum · claude•Review docs',
    );
    vi.useRealTimers();
  });
});

describe('handleFocusLinkedTab', () => {
  it('switches to the tab and flips the band to the terminal body', async () => {
    const handle = makeFakeHandle();
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    await bridge.handleFocusLinkedTab('t-1');
    expect(handle.switchTo).toHaveBeenCalledWith('my', 't-1');
    expect(deps.ensureTerminalOpen).toHaveBeenCalled();
    expect(deps.showTerminalBand).toHaveBeenCalled();
  });

  it('is a no-op when the terminal handle is missing', async () => {
    const deps = makeDeps(null);
    const bridge = createTerminalBridge(deps);
    await bridge.handleFocusLinkedTab('t-1');
    expect(deps.ensureTerminalOpen).not.toHaveBeenCalled();
    expect(deps.showTerminalBand).not.toHaveBeenCalled();
  });

  it('never spawns a shell — the tab to focus exists by construction', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleFocusLinkedTab('t-1');
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
  });
});

describe('linking the tab an action landed on', () => {
  it('links the focused tab from the built-in Work-on row, with no flag involved', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleWorkOn(sampleProject);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([
      { sid: 'session-1', label: 'conception · main' },
    ]);
  });

  it('names a shell it had to spawn exactly as the tab strip does', async () => {
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleWorkOn(sampleProject);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([{ sid: SPAWNED_SID, label: 'shell' }]);
  });

  it('types and links nothing when the spawned tab never joins the roster', async () => {
    // Focus never moved, so typing would land in whatever tab the user was
    // looking at — and a `submit` action would run it there. The action stops
    // instead, and says so.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    handle.spawnUserShell.mockResolvedValue('ghost');
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handleWorkOn(sampleProject);
    // The spawn settle (350 ms) plus the full roster-wait ceiling (3 s).
    await vi.advanceTimersByTimeAsync(3600);
    await promise;
    expect(handle.typedInto).toEqual([]);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
    expect(deps.flashToast).toHaveBeenCalledWith(expect.stringContaining('never opened'), 'error');
    vi.useRealTimers();
  });

  it('sends nothing to the focused tab when an agent tab never opens', async () => {
    // The dangerous shape: a `submit` action whose spawned tab never arrives
    // would otherwise type its template into the tab that held focus and press
    // Enter on it.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.spawnUserShell.mockResolvedValue('ghost');
    const deps = makeDeps(handle, [claudeAgent]);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'claude-deepseek-v4-pro',
      submit: true,
      link: true,
    });
    await vi.advanceTimersByTimeAsync(3600);
    await promise;
    expect(handle.typedInto).toEqual([]);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
    vi.useRealTimers();
  });

  it('leaves a configured action unlinked when it does not set link', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleProjectAction(sampleProject, { label: 'Review', template: 'review' });
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
  });

  it('links the focused tab when a configured action sets link', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review',
      link: true,
    });
    expect(linkedTabsOf(sampleProject.slug)).toEqual([
      { sid: 'session-1', label: 'conception · main' },
    ]);
  });

  it('links the tab the agent spawned, not the one that held focus', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent]));
    const promise = bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'claude-deepseek-v4-pro',
      link: true,
    });
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(linkedTabsOf(sampleProject.slug)).toEqual([
      { sid: SPAWNED_SID, label: 'DeepSeek v4 Pro' },
    ]);
    vi.useRealTimers();
  });

  it('links the spawned tab for a promptFlags agent too', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'agedum-claude',
      link: true,
    });
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(linkedTabsOf(sampleProject.slug)).toEqual([
      { sid: SPAWNED_SID, label: 'agedum · claude' },
    ]);
    vi.useRealTimers();
  });

  it('types into the tab it spawned, not the one that held focus', async () => {
    // The roster insert and the activation are separate steps in reconcile, and
    // `typeIntoActive` follows the active tab — so an action that spawned a tab
    // has to activate it before typing or the text lands somewhere else.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent]));
    const promise = bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'claude-deepseek-v4-pro',
      link: true,
    });
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.typedInto).toEqual([{ sid: SPAWNED_SID, text: 'review foo-bar' }]);
    vi.useRealTimers();
  });

  it('types into the shell it spawned when the pane was empty', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.handleWorkOn(sampleProject);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.typedInto).toEqual([{ sid: SPAWNED_SID, text: 'work on 2026-05-17-foo-bar' }]);
    vi.useRealTimers();
  });

  it('never links a new-project action — no project exists to link to', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handleNewProjectAction({ label: 'Starter', template: 'start', link: true });
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
  });
});

describe('runShellCommand', () => {
  it('types the command into the tab it spawned, not the one that held focus', async () => {
    // It always spawns a fresh tab and then submits with Enter, so a command
    // typed before that tab is active does not just go missing — it runs in
    // whatever tab the user was looking at.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(handle.typedInto).toEqual([
      { sid: SPAWNED_SID, text: 'condash skills install' },
      { sid: SPAWNED_SID, text: '\r' },
    ]);
    vi.useRealTimers();
  });

  it('sends nothing and says so when the spawned tab never joins the roster', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    // A sid the roster never learns about — the tab that never opens.
    handle.spawnUserShell.mockResolvedValue(NEVER_ARRIVES_SID);
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(4000);
    await promise;
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    expect(deps.flashToast).toHaveBeenCalledWith(expect.stringContaining('never opened'), 'error');
    vi.useRealTimers();
  });

  it('reports an unavailable terminal pane rather than failing silently', async () => {
    // The no-handle path spins on requestAnimationFrame, which the node test
    // environment does not provide.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    );
    const deps = makeDeps(null);
    const bridge = createTerminalBridge(deps);
    await bridge.runShellCommand('condash skills install');
    expect(deps.flashToast).toHaveBeenCalledWith('Terminal pane not available.', 'error');
    vi.unstubAllGlobals();
  });
});

describe('handlePasteToTerm', () => {
  it('pastes into the shell it spawned when the pane was empty', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.handlePasteToTerm('/home/alice/resources/spec.txt');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.typedInto).toEqual([
      { sid: SPAWNED_SID, text: '/home/alice/resources/spec.txt' },
    ]);
    vi.useRealTimers();
  });

  it('pastes into the tab already in focus without spawning one', async () => {
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    await bridge.handlePasteToTerm('/home/alice/resources/spec.txt');
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
    expect(handle.typedInto).toEqual([
      { sid: 'session-1', text: '/home/alice/resources/spec.txt' },
    ]);
  });

  it('pastes nothing and says so when the spawned tab never joins the roster', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.hasActive.mockReturnValue(false);
    handle.spawnUserShell.mockResolvedValue(NEVER_ARRIVES_SID);
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handlePasteToTerm('/home/alice/resources/spec.txt');
    await vi.advanceTimersByTimeAsync(4000);
    await promise;
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    expect(deps.flashToast).toHaveBeenCalledWith(expect.stringContaining('never opened'), 'error');
    vi.useRealTimers();
  });

  it('reports an unavailable terminal pane rather than failing silently', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0),
    );
    const deps = makeDeps(null);
    const bridge = createTerminalBridge(deps);
    await bridge.handlePasteToTerm('/home/alice/resources/spec.txt');
    expect(deps.flashToast).toHaveBeenCalledWith('Terminal pane not available.', 'error');
    vi.unstubAllGlobals();
  });
});
