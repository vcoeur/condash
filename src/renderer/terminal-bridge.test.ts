import { describe, expect, it, vi } from 'vitest';
import { createTerminalBridge } from './terminal-bridge';
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
  waitForReady: ReturnType<typeof vi.fn>;
};

function makeFakeHandle(): FakeHandle {
  return {
    spawn: vi.fn().mockResolvedValue(''),
    switchTo: vi.fn(),
    spawnUserShell: vi.fn().mockResolvedValue(''),
    moveActiveTab: vi.fn(),
    typeIntoActive: vi.fn(),
    hasActive: vi.fn().mockReturnValue(true),
    getActiveSessionId: vi.fn().mockReturnValue('session-1'),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(handle: FakeHandle | null = null, agents: Agent[] = []) {
  return {
    terminalHandle: () => handle as unknown as TerminalPaneHandle | null,
    ensureTerminalOpen: vi.fn(),
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
    const promise = bridge.runTask('kimi-cli-native', 'review the docs');
    await vi.advanceTimersByTimeAsync(600);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(kimiAgent, 'my');
    expect(handle.typeIntoActive).toHaveBeenCalledWith('review the docs');
    expect(handle.typeIntoActive).toHaveBeenLastCalledWith('\r');
    vi.useRealTimers();
  });

  it('toasts and does nothing when the agent is unknown', async () => {
    const handle = makeFakeHandle();
    const deps = makeDeps(handle, [claudeAgent]);
    const bridge = createTerminalBridge(deps);
    await bridge.runTask('does-not-exist', 'text');
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
    const promise = bridge.runTask('agedum-claude', 'review the docs');
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'review the docs'" },
      'my',
    );
    expect(handle.typeIntoActive).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('single-quotes a prompt containing quotes and special chars', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const bridge = createTerminalBridge(makeDeps(handle, [agedumAgent]));
    const promise = bridge.runTask('agedum-claude', "it's a $PATH; rm -rf");
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { ...agedumAgent, command: "agedum claude --prompt 'it'\\''s a $PATH; rm -rf'" },
      'my',
    );
    vi.useRealTimers();
  });
});
