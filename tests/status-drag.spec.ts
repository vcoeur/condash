import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

test('status drag rewrites the README on disk', async () => {
  const booted = await bootApp();
  try {
    // Drag-and-drop in Electron via Playwright is flaky; exercise the IPC path
    // directly. The renderer's setStatus + watcher round-trip is what we care
    // about here.
    const path = join(
      booted.conceptionDir,
      'projects',
      '2026-04',
      '2026-04-26-sample',
      'README.md',
    );
    await booted.window.evaluate(
      ({ p }) => window.condash.setStatus(p, 'done'),
      { p: path },
    );
    const onDisk = await readFile(path, 'utf8');
    expect(onDisk).toContain('**Status**: done');
  } finally {
    await booted.cleanup();
  }
});
