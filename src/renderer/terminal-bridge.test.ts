import { describe, expect, it, vi } from 'vitest';
import { createTerminalBridge } from './terminal-bridge';
import type { TerminalPaneHandle } from './terminal-pane';
import type { ActionTemplate, Project, TerminalPrefs } from '@shared/types';

type FakeHandle = {
  spawn: ReturnType<typeof vi.fn>;
  switchTo: ReturnType<typeof vi.fn>;
  spawnUserShell: ReturnType<typeof vi.fn>;
  moveActiveTab: ReturnType<typeof vi.fn>;
  typeIntoActive: ReturnType<typeof vi.fn>;
  hasActive: ReturnType<typeof vi.fn>;
};

function makeFakeHandle(): FakeHandle {
  return {
    spawn: vi.fn().mockResolvedValue(''),
    switchTo: vi.fn(),
    spawnUserShell: vi.fn().mockResolvedValue(''),
    moveActiveTab: vi.fn(),
    typeIntoActive: vi.fn(),
    hasActive: vi.fn().mockReturnValue(true),
  };
}

function makeDeps(handle: FakeHandle | null = null, prefs: TerminalPrefs = {}) {
  return {
    terminalHandle: () => handle as unknown as TerminalPaneHandle | null,
    ensureTerminalOpen: vi.fn(),
    terminalPrefs: (): TerminalPrefs => prefs,
    flashToast: vi.fn(),
    conceptionPath: () => '/home/alice/src/vcoeur/conception',
  };
}

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

  it('spawns the bound launcher and types into the new tab when action.launcher is set', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const prefs: TerminalPrefs = {
      launchers: [
        { label: 'Claude', command: 'claude' },
        { label: 'KimiKimi', command: 'kimi-kimi' },
      ],
    };
    const bridge = createTerminalBridge(makeDeps(handle, prefs));
    const action: ActionTemplate = {
      label: 'Start new project',
      template: 'Start new project ',
      launcher: 'KimiKimi',
    };
    const promise = bridge.handleNewProjectAction(action);
    // Drain the launcher-spawn settle delay (~350 ms).
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { label: 'KimiKimi', command: 'kimi-kimi' },
      'my',
    );
    expect(handle.typeIntoActive).toHaveBeenCalledWith('Start new project ');
    vi.useRealTimers();
  });

  it('falls back to the focused-tab flow when action.launcher does not match any configured launcher', async () => {
    const handle = makeFakeHandle();
    const prefs: TerminalPrefs = {
      launchers: [{ label: 'Claude', command: 'claude' }],
    };
    const bridge = createTerminalBridge(makeDeps(handle, prefs));
    const action: ActionTemplate = {
      label: 'Start new project',
      template: 'Start new project ',
      launcher: 'NonExistent',
    };
    await bridge.handleNewProjectAction(action);
    // No spawn — handle is already active, fell through to the default flow
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
    expect(handle.typeIntoActive).toHaveBeenCalledWith('Start new project ');
  });

  it('skips a launcher whose command is empty (treats it as not configured)', async () => {
    const handle = makeFakeHandle();
    const prefs: TerminalPrefs = {
      launchers: [
        { label: 'Claude', command: 'claude' },
        { label: 'EmptyLauncher', command: '' },
      ],
    };
    const bridge = createTerminalBridge(makeDeps(handle, prefs));
    const action: ActionTemplate = {
      label: 'Start new project',
      template: 'Start new project ',
      launcher: 'EmptyLauncher',
    };
    await bridge.handleNewProjectAction(action);
    expect(handle.spawnUserShell).not.toHaveBeenCalled();
  });
});

describe('handleProjectAction with launcher binding', () => {
  it('spawns the bound launcher before typing the substituted template', async () => {
    vi.useFakeTimers();
    const handle = makeFakeHandle();
    const prefs: TerminalPrefs = {
      launchers: [{ label: 'Claude', command: 'claude' }],
    };
    const bridge = createTerminalBridge(makeDeps(handle, prefs));
    const action: ActionTemplate = {
      label: 'Review',
      template: 'review {shortSlug}',
      launcher: 'Claude',
    };
    const promise = bridge.handleProjectAction(sampleProject, action);
    await vi.advanceTimersByTimeAsync(400);
    await promise;
    expect(handle.spawnUserShell).toHaveBeenCalledWith(
      { label: 'Claude', command: 'claude' },
      'my',
    );
    expect(handle.typeIntoActive).toHaveBeenCalledWith('review foo-bar');
    vi.useRealTimers();
  });
});
