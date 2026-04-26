import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('writeNote round-trips with the drift guard', async () => {
  const booted = await bootApp();
  try {
    const path = join(
      booted.conceptionDir,
      'projects',
      '2026-04',
      '2026-04-26-sample',
      'README.md',
    );
    const original = await readFile(path, 'utf8');
    const next = original + '\n\n## Added section\n\nFresh content.\n';

    await booted.window.evaluate(
      ({ p, expected, content }) => window.condash.writeNote(p, expected, content),
      { p: path, expected: original, content: next },
    );

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toBe(next);

    // Drift guard: a stale baseline must reject the write.
    const failure = await booted.window.evaluate(
      ({ p, expected, content }) =>
        window.condash
          .writeNote(p, expected, content)
          .then(() => null)
          .catch((err) => (err as Error).message),
      { p: path, expected: original, content: original },
    );
    expect(failure).toMatch(/drift/i);
  } finally {
    await booted.cleanup();
  }
});
