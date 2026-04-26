import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('toggleStep cycles a marker and rewrites the line on disk', async () => {
  const booted = await bootApp();
  try {
    const path = join(
      booted.conceptionDir,
      'projects',
      '2026-04',
      '2026-04-26-sample',
      'README.md',
    );
    const project = await booted.window.evaluate(
      ({ p }) => window.condash.getProject(p),
      { p: path },
    );
    expect(project).not.toBeNull();
    const step = project!.steps[0];
    expect(step.marker).toBe(' ');

    await booted.window.evaluate(
      ({ p, lineIndex, expected, next }) =>
        window.condash.toggleStep(p, lineIndex, expected, next),
      { p: path, lineIndex: step.lineIndex, expected: ' ' as const, next: '~' as const },
    );

    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('- [~] First step');
  } finally {
    await booted.cleanup();
  }
});
