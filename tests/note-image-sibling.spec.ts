import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootApp } from './fixtures/electron-app';

// 1×1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('note view: ../sibling/<file> image renders via condash-file:// protocol (#85)', async () => {
  const booted = await bootApp();
  try {
    const projectDir = join(
      booted.conceptionDir,
      'projects',
      '2026-04',
      '2026-04-26-sample',
    );
    const notesDir = join(projectDir, 'notes');
    const picturesDir = join(projectDir, 'pictures');
    await mkdir(notesDir, { recursive: true });
    await mkdir(picturesDir, { recursive: true });
    await writeFile(join(picturesDir, 'sample.png'), PNG_BYTES);
    const notePath = join(notesDir, '01-note.md');
    await writeFile(
      notePath,
      '# Repro\n\nSome text.\n\n![Caption](../pictures/sample.png)\n\nMore text.\n',
      'utf8',
    );

    // The renderer-side rewrite is unit-tested in isolation; here we pin the
    // end-to-end protocol path by constructing the URL the rewrite would
    // produce and fetching it through the protocol handler. A 200 + non-empty
    // body proves the sandbox check accepts a sibling-folder path one level
    // up from the note's directory.
    // Also probe the simple "image next to the note" case — both shapes
    // share the same protocol-handler path, both must pass.
    await writeFile(join(notesDir, 'inline.png'), PNG_BYTES);

    const buildUrl = (abs: string): string =>
      `condash-file:///${abs.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
    const sameDir = buildUrl(join(notesDir, 'inline.png'));
    const sibling = buildUrl(join(picturesDir, 'sample.png'));

    const probe = (u: string) =>
      booted.window.evaluate((url) => {
        return new Promise<{ loaded: boolean; width: number }>((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ loaded: true, width: img.naturalWidth });
          img.onerror = () => resolve({ loaded: false, width: 0 });
          img.src = url;
        });
      }, u);

    expect((await probe(sameDir)).loaded).toBe(true);
    expect((await probe(sibling)).loaded).toBe(true);
  } finally {
    await booted.cleanup();
  }
});
