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
  typeInto: ReturnType<typeof vi.fn>;
  activeLiveSessionId: ReturnType<typeof vi.fn>;
  sessionLabel: ReturnType<typeof vi.fn>;
  /** Display name per sid — the roster `sessionLabel` reads. A sid absent here
   *  is a tab the renderer has not inserted yet. */
  labels: Record<string, string>;
  /** Sids whose process has exited. The controller keeps the row for an
   *  abnormal death so the user can read the verdict, so "in the roster" and
   *  "alive" are different questions — and only the second one means the tab
   *  can still be written to. */
  exited: Set<string>;
  /** Every delivery with the tab it reached, as named by `typeInto`. Lets a
   *  test assert *which* tab the text landed in, not just that something was
   *  typed. */
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
  let spawnCount = 0;
  const handle: FakeHandle = {
    spawn: vi.fn().mockResolvedValue(''),
    switchTo: vi.fn((_side: string, id?: string) => {
      // No-ops on a tab the roster does not hold, exactly as the controller's
      // does — that is what makes "poll for membership, then switch" ordering
      // load-bearing, so the double has to enforce it too.
      if (id && handle.labels[id] !== undefined) activeId = id;
    }),
    spawnUserShell: vi.fn(async (agent?: Agent | null, _side?: string, titleOverride?: string) => {
      // Distinct id per spawn, as the real one gives: a test about two spawns
      // racing cannot say anything if both answer with the same tab.
      const sid = spawnCount === 0 ? SPAWNED_SID : `${SPAWNED_SID}-${spawnCount + 1}`;
      spawnCount += 1;
      handle.labels[sid] = titleOverride ?? agent?.label ?? 'shell';
      return sid;
    }),
    moveActiveTab: vi.fn(),
    // Named delivery, modelled as the controller's is: it writes to the sid it
    // is given whatever is active, and refuses once that tab is no longer live.
    // A double that wrote regardless would hide exactly the mis-address this
    // handle exists to prevent.
    typeInto: vi.fn((sid: string, text: string) => {
      if (handle.labels[sid] === undefined || handle.exited.has(sid)) return false;
      handle.typedInto.push({ sid, text });
      return true;
    }),
    // Live means present and not exited — the same distinction the controller
    // draws, and the reason an abnormally-dead tab must not block a spawn.
    activeLiveSessionId: vi.fn(() => (activeId && !handle.exited.has(activeId) ? activeId : null)),
    sessionLabel: vi.fn((sid: string) => handle.labels[sid] ?? null),
    labels: { 'session-1': 'conception · main' },
    exited: new Set<string>(),
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
    expect(handle.typeInto).toHaveBeenCalledWith('session-1', 'work on 2026-05-17-foo-bar');
  });

  it('opens the pane and spawns a shell when none is active', async () => {
    const handle = makeFakeHandle();
    handle.activeLiveSessionId.mockReturnValue(null);
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    await bridge.handleWorkOn(sampleProject);
    expect(deps.ensureTerminalOpen).toHaveBeenCalled();
    expect(handle.spawnUserShell).toHaveBeenCalled();
    expect(handle.typeInto).toHaveBeenCalledWith(SPAWNED_SID, 'work on 2026-05-17-foo-bar');
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
    expect(handle.typeInto).toHaveBeenCalledWith('session-1', 'claude "review foo-bar"');
    expect(handle.typeInto).toHaveBeenCalledTimes(1);
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
    // Both writes, and the tab each reached: a mis-addressed Enter submits
    // another tab's prompt, so "an Enter was sent" is not the guarantee.
    expect(handle.typedInto).toEqual([
      { sid: 'session-1', text: 'claude "review foo-bar"' },
      { sid: 'session-1', text: '\r' },
    ]);
    vi.useRealTimers();
  });

  it('shows an error toast when spawning a shell fails', async () => {
    const handle = makeFakeHandle();
    handle.activeLiveSessionId.mockReturnValue(null);
    handle.spawnUserShell.mockRejectedValue(new Error('No shell'));
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    await bridge.handleProjectAction(sampleProject, { label: 'X', template: 'x' });
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('Could not open a shell'),
      'error',
    );
    expect(handle.typeInto).not.toHaveBeenCalled();
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
    expect(handle.typeInto).toHaveBeenCalledTimes(1);
    const call = vi.mocked(handle.typeInto).mock.calls[0][1] as string;
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
    expect(handle.typedInto).toEqual([
      { sid: 'session-1', text: 'draft conception' },
      { sid: 'session-1', text: '\r' },
    ]);
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
    expect(handle.typeInto).toHaveBeenCalledWith(expect.any(String), 'Start new project ');
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
    expect(handle.typeInto).toHaveBeenCalledWith(expect.any(String), 'Start new project ');
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
    expect(handle.typeInto).toHaveBeenCalledWith(SPAWNED_SID, 'review foo-bar');
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
    expect(handle.typeInto).not.toHaveBeenCalled();
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
    expect(handle.typedInto).toEqual([
      { sid: SPAWNED_SID, text: 'review the docs' },
      { sid: SPAWNED_SID, text: '\r' },
    ]);
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
    expect(handle.typeInto).not.toHaveBeenCalled();
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
    expect(handle.typeInto).not.toHaveBeenCalled();
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
    expect(handle.typeInto).not.toHaveBeenCalled();
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
    handle.activeLiveSessionId.mockReturnValue(null);
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
    handle.activeLiveSessionId.mockReturnValue(null);
    handle.spawnUserShell.mockResolvedValue('ghost');
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handleWorkOn(sampleProject);
    // The spawn settle (350 ms) plus the full roster-wait ceiling (3 s).
    await vi.advanceTimersByTimeAsync(3600);
    await promise;
    expect(handle.typedInto).toEqual([]);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('did not open in time'),
      'error',
    );
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
    // Delivery names the tab it means — so an action that spawned one writes
    // there whatever else has taken focus in the meantime.
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
    handle.activeLiveSessionId.mockReturnValue(null);
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.handleWorkOn(sampleProject);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.typedInto).toEqual([{ sid: SPAWNED_SID, text: 'work on 2026-05-17-foo-bar' }]);
    vi.useRealTimers();
  });

  it('still links when the prompt was typed but its Enter was refused', async () => {
    // The prompt is sitting in that tab either way, so the tab is working on
    // the project — a refused Enter is a thing to say, not a reason to forget.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [claudeAgent]));
    const promise = bridge.handleProjectAction(sampleProject, {
      label: 'Review',
      template: 'review {shortSlug}',
      agent: 'claude-deepseek-v4-pro',
      submit: true,
      link: true,
    });
    await vi.advanceTimersByTimeAsync(360);
    handle.exited.add(SPAWNED_SID);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(linkedTabsOf(sampleProject.slug)).toEqual([
      { sid: SPAWNED_SID, label: 'DeepSeek v4 Pro' },
    ]);
    vi.useRealTimers();
  });

  it('links nothing when the text never reached the tab', async () => {
    // The user has just been told nothing was sent; recording the relation
    // anyway claims the tab is working on the project.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handleWorkOn(sampleProject);
    handle.exited.add('session-1');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.typedInto).toEqual([]);
    expect(linkedTabsOf(sampleProject.slug)).toEqual([]);
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('no longer live'),
      'error',
    );
    vi.useRealTimers();
  });

  it('opens a shell when the only tab there has died', async () => {
    // An abnormal exit KEEPS its row and stays the active id, so asking whether
    // a tab is active answers yes for a dead pty. The action would then hand its
    // text to a session main drops it for, and never open the shell it needed.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.exited.add('session-1');
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.handleWorkOn(sampleProject);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalled();
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

describe('two actions racing an empty pane', () => {
  it('gives each its own tab rather than interleaving them in one', async () => {
    // Deduplicating the in-flight spawn looks tidier and is wrong: two actions
    // sharing a tab write across each other's 50 ms gap before the Enter, and
    // the shell runs the two commands concatenated. A second tab is a surprise;
    // a concatenated command is a wrong command.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    handle.activeLiveSessionId.mockReturnValue(null);
    const bridge = createTerminalBridge(makeDeps(handle));
    const first = bridge.handleProjectAction(sampleProject, {
      label: 'A',
      template: 'run a',
      submit: true,
    });
    const second = bridge.handleProjectAction(sampleProject, {
      label: 'B',
      template: 'run b',
      submit: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(handle.spawnUserShell).toHaveBeenCalledTimes(2);
    // Each command, and its Enter, alone in its own tab.
    const tabs = new Set(handle.typedInto.map((call) => call.sid));
    expect(tabs.size).toBe(2);
    for (const sid of tabs) {
      expect(handle.typedInto.filter((call) => call.sid === sid).map((c) => c.text)).toEqual([
        expect.stringMatching(/^run [ab]$/),
        '\r',
      ]);
    }
    vi.useRealTimers();
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

  it('keeps writing to its own tab when another tab takes focus meanwhile', async () => {
    // The focus wait returns as soon as the tab joins the roster, while the
    // reconcile pass that inserted it is still mid-import — so it can come back
    // and activate another restored session inside the 50 ms gap before the
    // Enter. Delivery names the sid, so the Enter still lands where the command
    // went; an Enter on the other tab would submit that tab's prompt.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    // Past the settle and the focus step: the command is typed, the gap is open.
    await vi.advanceTimersByTimeAsync(360);
    handle.labels['session-restored'] = 'restored';
    handle.switchTo('my', 'session-restored');
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(handle.typedInto).toEqual([
      { sid: SPAWNED_SID, text: 'condash skills install' },
      { sid: SPAWNED_SID, text: '\r' },
    ]);
    vi.useRealTimers();
  });

  it('reports failure when the command was typed but never submitted', async () => {
    // Its caller schedules work off this answer, and a prompt left unsubmitted
    // is not a command that ran.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(360);
    handle.exited.add(SPAWNED_SID);
    await vi.advanceTimersByTimeAsync(100);
    expect(await promise).toBe(false);
    vi.useRealTimers();
  });

  it('brings the terminal body up, not just the tab', async () => {
    // `switchTo` sets the active id and column; it does not flip the bottom
    // band. With the Dashboard body showing, every xterm is display:none, so
    // the command would be delivered correctly to a tab nobody can see.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(deps.showTerminalBand).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('reports success when the command was typed and submitted', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(500);
    expect(await promise).toBe(true);
    vi.useRealTimers();
  });

  it('does not press Enter into a tab whose process died before the Enter', async () => {
    // An abnormal exit KEEPS its row so the user can read the death verdict, so
    // the tab is still in the roster while its pty is gone — main drops writes
    // to it silently. Membership is not liveness.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(360);
    handle.exited.add(SPAWNED_SID);
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(handle.typedInto).toEqual([{ sid: SPAWNED_SID, text: 'condash skills install' }]);
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('was not submitted'),
      'error',
    );
    vi.useRealTimers();
  });

  it('does not press Enter when its tab disappears before the Enter', async () => {
    // An agent launched on a bad command exits and the controller closes its
    // tab. If that lands in the 50 ms gap, a bare Enter would go to whatever
    // tab is active now and submit whatever sits on its prompt.
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle));
    const promise = bridge.runShellCommand('condash skills install', 'skills install');
    await vi.advanceTimersByTimeAsync(360);
    delete handle.labels[SPAWNED_SID];
    await vi.advanceTimersByTimeAsync(100);
    await promise;
    expect(handle.typedInto).toEqual([{ sid: SPAWNED_SID, text: 'condash skills install' }]);
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
    expect(handle.typeInto).not.toHaveBeenCalled();
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('did not open in time'),
      'error',
    );
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
    handle.activeLiveSessionId.mockReturnValue(null);
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
    handle.activeLiveSessionId.mockReturnValue(null);
    handle.spawnUserShell.mockResolvedValue(NEVER_ARRIVES_SID);
    const deps = makeDeps(handle);
    const bridge = createTerminalBridge(deps);
    const promise = bridge.handlePasteToTerm('/home/alice/resources/spec.txt');
    await vi.advanceTimersByTimeAsync(4000);
    await promise;
    expect(handle.typeInto).not.toHaveBeenCalled();
    expect(deps.flashToast).toHaveBeenCalledWith(
      expect.stringContaining('did not open in time'),
      'error',
    );
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
