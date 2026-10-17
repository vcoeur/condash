import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import type { VoiceCredentialStatus } from '@shared/types';
import { createVoiceKeyStatus } from './voice-key-status';

const missing: VoiceCredentialStatus = {
  openrouter: { present: false, source: 'none' },
};
const detected: VoiceCredentialStatus = {
  ...missing,
  openrouter: { present: true, source: 'agents-env' },
};

describe('saved voice-key refresh ownership', () => {
  it('drops stale success/rejection and disposed replies, never accepts draft data', async () => {
    const reads: {
      resolve: (value: VoiceCredentialStatus) => void;
      reject: (error: Error) => void;
    }[] = [];
    const read = vi.fn(
      () =>
        new Promise<VoiceCredentialStatus>((resolve, reject) => reads.push({ resolve, reject })),
    );
    let keys!: ReturnType<typeof createVoiceKeyStatus>;
    const dispose = createRoot((dispose) => {
      keys = createVoiceKeyStatus(read);
      return dispose;
    });
    expect(keys.snapshot()).toEqual({ phase: 'not-checked' });
    const first = keys.refresh();
    const second = keys.refresh();
    expect(keys.snapshot()).toEqual({ phase: 'pending' });
    reads[1].resolve(detected);
    await second;
    reads[0].resolve(missing);
    await first;
    expect(keys.snapshot()).toMatchObject({ phase: 'checked', keys: detected });
    const third = keys.refresh();
    const fourth = keys.refresh();
    reads[2].reject(new Error('/private/path'));
    await third;
    expect(keys.snapshot()).toEqual({ phase: 'pending' });
    reads[3].reject(new Error('/private/path'));
    await fourth;
    expect(keys.snapshot()).toEqual({ phase: 'error' });
    const final = keys.refresh();
    dispose();
    reads[4].resolve(detected);
    await final;
    expect(keys.snapshot()).toEqual({ phase: 'pending' });
    expect(read.mock.calls).toEqual([[], [], [], [], []]);
  });
});
