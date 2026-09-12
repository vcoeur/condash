import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureStdout } from './test-helpers';

describe('captureStdout', () => {
  afterEach(() => {
    // This also prevents a failed assertion from leaking a test capture.
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  });

  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;

  it('restores an outer capture after a nested capture completes', async () => {
    let inner: Awaited<ReturnType<typeof captureStdout>> | undefined;

    const outer = await captureStdout(async () => {
      process.stdout.write('outer before stdout');
      process.stderr.write('outer before stderr');

      inner = await captureStdout(() => {
        process.stdout.write('inner stdout');
        process.stderr.write('inner stderr');
      });

      process.stdout.write('outer after stdout');
      process.stderr.write('outer after stderr');
    });

    expect(inner).toMatchObject({
      stdout: 'inner stdout',
      stderr: 'inner stderr',
      threw: undefined,
    });
    expect(outer).toMatchObject({
      stdout: 'outer before stdoutouter after stdout',
      stderr: 'outer before stderrouter after stderr',
      threw: undefined,
    });
  });

  it('keeps timed-out stdout and stderr out of a replacement capture and the original writers', async () => {
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const originalStdoutWriter = vi.fn(() => true);
    const originalStderrWriter = vi.fn(() => true);
    process.stdout.write = originalStdoutWriter as typeof process.stdout.write;
    process.stderr.write = originalStderrWriter as typeof process.stderr.write;

    const abandoned = captureStdout(async () => {
      await slow;
      process.stdout.write('slow stdout');
      process.stderr.write('slow stderr');
    });

    const later = await captureStdout(async () => {
      process.stdout.write('later stdout');
      process.stderr.write('later stderr');
      releaseSlow?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(later).toMatchObject({
      stdout: 'later stdout',
      stderr: 'later stderr',
      threw: undefined,
    });

    const abandonedResult = await abandoned;
    expect(abandonedResult).toMatchObject({
      stdout: 'slow stdout',
      stderr: 'slow stderr',
      threw: undefined,
    });
    expect(originalStdoutWriter).not.toHaveBeenCalled();
    expect(originalStderrWriter).not.toHaveBeenCalled();
    expect(process.stdout.write).toBe(originalStdoutWriter);
    expect(process.stderr.write).toBe(originalStderrWriter);
  });
});
