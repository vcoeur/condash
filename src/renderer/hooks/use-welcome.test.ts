/**
 * Regression test for the template-init welcome-marker race. The one-shot
 * effect in `use-welcome` persists `welcome.initShown = true` the instant
 * `welcomeInitPending` flips, so `handleTemplateInit` must land the `false`
 * marker on disk BEFORE flipping the signal — flipping first makes the two
 * `updateSettings` calls race (concurrent read-modify-write, last finisher
 * wins) and the shown-marker can be clobbered, re-showing the welcome on
 * every launch. Surfaced by the tree-reload activation gate (B2a), which
 * removed a second, accidental effect re-fire that used to write `true`
 * again after the dust settled (first-run-onboarding.spec.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';

const getBootstrap = vi.hoisted(() => vi.fn());
vi.mock('../bootstrap', () => ({ getBootstrap }));

import { useWelcome } from './use-welcome';

/** Solid effects are scheduled, not synchronous — let them run. */
const flushEffects = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const setWelcomeInitShown = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Bootstrap reports the marker already shown, so only handleTemplateInit
  // can flip the pending signal in these tests.
  getBootstrap.mockResolvedValue({ welcomeDismissed: false, welcomeInitShown: true });
  vi.stubGlobal('window', {
    condash: { setWelcomeInitShown, setWelcomeDismissed: vi.fn() },
  });
});

function bootWelcome() {
  const [conceptionPath] = createSignal<string | null>('/c');
  const [projectsLoaded] = createSignal(true);
  let welcome!: ReturnType<typeof useWelcome>;
  const dispose = createRoot((disposeRoot) => {
    welcome = useWelcome({
      conceptionPath,
      projectsLoaded,
      projects: () => [],
      knowledgeIsEmpty: () => true,
      setHelpDoc: () => {},
    });
    return disposeRoot;
  });
  return { welcome, dispose };
}

describe('useWelcome — handleTemplateInit sequences the marker writes', () => {
  it('flips the pending signal only after the false-write resolves', async () => {
    const write = deferred();
    setWelcomeInitShown.mockReturnValue(write.promise);
    const { welcome, dispose } = bootWelcome();
    await flushEffects();

    welcome.handleTemplateInit();

    // The false-write is in flight; pending must NOT have flipped yet, so
    // the effect cannot have fired a racing true-write.
    expect(setWelcomeInitShown).toHaveBeenCalledTimes(1);
    expect(setWelcomeInitShown).toHaveBeenNthCalledWith(1, false);
    await flushEffects();
    expect(setWelcomeInitShown).toHaveBeenCalledTimes(1);

    // Once the false-write lands, pending flips and the effect persists true.
    write.resolve();
    await flushEffects();
    expect(setWelcomeInitShown).toHaveBeenNthCalledWith(2, true);
    dispose();
  });

  it('still flips the pending signal when the false-write rejects', async () => {
    setWelcomeInitShown.mockRejectedValue(new Error('ipc down'));
    const { welcome, dispose } = bootWelcome();
    await flushEffects();

    welcome.handleTemplateInit();
    await flushEffects();

    // Rejection still flips pending (the welcome shows; the marker just
    // won't persist) — and the effect then attempts the true-write.
    expect(setWelcomeInitShown).toHaveBeenCalledWith(false);
    expect(setWelcomeInitShown).toHaveBeenCalledWith(true);
    dispose();
  });
});
