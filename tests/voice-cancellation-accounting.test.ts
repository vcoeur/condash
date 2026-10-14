import { it, vi } from 'vitest';

const scenarios = [
  '300 delayed successful replies after stop',
  '300 delayed successful replies after tab departure',
  '300 delayed successful replies after disposal',
  '300 delayed refused replies after stop',
  '300 delayed rejected replies after stop',
  '300 rejected starts while still recording',
  'cancel rejection before delivery',
  'cancel rejection after delivery',
  'persistent cancellation rejection is reported',
] as const;

for (const scenario of scenarios) {
  it(scenario, async () => {
    vi.resetModules();
    const { exerciseCancellationAccounting } = await import('./fixtures/voice-owner-lifecycle');
    await exerciseCancellationAccounting(scenario);
  });
}
