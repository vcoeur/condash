/**
 * Review-round-1 SHOULD (exec.ts): if `armSpawnDeadline` throws — worker
 * construction failing under resource pressure — the exec must still follow
 * the child's own outcome (resolve on success, reject on the child's error)
 * rather than reject spuriously. execFile's internal `timeout` backstop
 * remains armed in that case.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./spawn-deadline', () => ({
  armSpawnDeadline: vi.fn(() => {
    throw new Error('worker spawn failed');
  }),
}));

import { exec } from './exec';

describe('exec spawnDeadlineMs — deadline-worker construction failure', () => {
  it('still resolves with the child outcome when the child succeeds', async () => {
    const { stdout } = await exec(process.execPath, ['-e', 'console.log("ok")'], {
      spawnDeadlineMs: 5_000,
    });
    expect(stdout).toContain('ok');
  });

  it('still rejects with the child error when the child fails', async () => {
    const err = await exec(process.execPath, ['-e', 'process.exit(3)'], {
      spawnDeadlineMs: 5_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: number }).code).toBe(3);
  });
});
