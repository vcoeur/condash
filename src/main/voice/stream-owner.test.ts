import { beforeEach, expect, it, vi } from 'vitest';
import type { VoiceStreamSessionDeps } from './stream';
const deps = (
  ownerId: string,
  overrides: Partial<VoiceStreamSessionDeps> = {},
): VoiceStreamSessionDeps => ({
  ownerId,
  sid: 'same-tab',
  onPartial: vi.fn(),
  insert: vi.fn(() => ({ inserted: true, chars: 5 })),
  transcribe: vi.fn(async () => ({
    text: 'final',
    provider: 'openrouter' as const,
    producer: 'openrouter-native' as const,
  })),
  ...overrides,
});
beforeEach(() => vi.resetModules());
it('bounded finished-owner eviction never removes genuine pre-start cancellation protection', async () => {
  const stream = await import('./stream');
  stream.cancelActiveVoiceStream('protected');
  for (let index = 0; index < 300; index++) {
    const admission = stream.reserveVoiceStream(`finished-${index}`);
    expect(admission.ok).toBe(true);
    if (admission.ok) stream.releaseVoiceStream(admission.reservation);
  }
  expect(stream.reserveVoiceStream('protected').ok).toBe(false);
});
it('300 retired compensating cancels leave all 256 unmatched marker slots available', async () => {
  const stream = await import('./stream');
  for (let index = 0; index < 300; index++) {
    const ownerId = `retired-${index}`;
    const admission = stream.reserveVoiceStream(ownerId);
    expect(admission.ok).toBe(true);
    if (admission.ok) stream.releaseVoiceStream(admission.reservation);
    stream.cancelActiveVoiceStream(ownerId);
  }
  for (let index = 0; index < 256; index++) stream.cancelActiveVoiceStream(`pending-${index}`);
  const next = stream.reserveVoiceStream('fresh');
  expect(next.ok).toBe(true);
  if (next.ok) stream.releaseVoiceStream(next.reservation);
  stream.cancelActiveVoiceStream('overflow');
  expect(stream.reserveVoiceStream('closed').ok).toBe(false);
  for (let index = 0; index < 256; index++)
    expect(stream.reserveVoiceStream(`pending-${index}`).ok).toBe(false);
  expect(stream.reserveVoiceStream('still-closed').ok).toBe(false);
});
it('consumes only a matching pre-start cancellation marker', async () => {
  const stream = await import('./stream');
  stream.cancelActiveVoiceStream('a');
  stream.cancelActiveVoiceStream('b');
  expect(stream.reserveVoiceStream('a').ok).toBe(false);
  const next = stream.reserveVoiceStream('next');
  expect(next.ok).toBe(true);
  if (next.ok) stream.releaseVoiceStream(next.reservation);
  expect(stream.reserveVoiceStream('b').ok).toBe(false);
});
it('cancelled setup continuation cannot clear a newer reservation', async () => {
  const stream = await import('./stream');
  const starting = stream.beginVoiceStream(deps('old'));
  stream.cancelActiveVoiceStream('old');
  expect((await stream.beginVoiceStream(deps('new'))).ok).toBe(true);
  expect((await starting).ok).toBe(false);
  expect(stream.getActiveVoiceStream('new')?.ownerId).toBe('new');
  stream.cancelActiveVoiceStream('new');
});
it('authorized stopped final completes once against its captured target while a new owner captures', async () => {
  const stream = await import('./stream');
  let finish!: (value: any) => void;
  const oldDeps = deps('old', {
    transcribe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await stream.beginVoiceStream(oldDeps);
  stream.getActiveVoiceStream('old')!.handleAudio('AAA=');
  const stopped = stream.takeActiveVoiceStream('old')!;
  const stopping = stopped.stop();
  await stream.beginVoiceStream(deps('new'));
  stream.cancelActiveVoiceStream('old');
  finish({ text: 'final', provider: 'openrouter', producer: 'openrouter-native' });
  expect((await stopping).inserted).toBe(true);
  await stopped.stop();
  expect(oldDeps.insert).toHaveBeenCalledTimes(1);
  expect(oldDeps.insert).toHaveBeenCalledWith('same-tab', 'final');
  expect(stream.getActiveVoiceStream('new')?.ownerId).toBe('new');
  stream.cancelActiveVoiceStream('new');
});
