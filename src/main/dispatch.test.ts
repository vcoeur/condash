import { describe, expect, test } from 'vitest';

import { decideDispatch } from './dispatch';

describe('decideDispatch (unified-binary rule C)', () => {
  test('no args → GUI', () => {
    expect(decideDispatch(['/path/to/condash.bin'])).toEqual({
      kind: 'gui',
      argv: ['/path/to/condash.bin'],
    });
  });

  test('empty-string first arg → GUI', () => {
    // Defensive: some shells emit an empty token; treat it as no-args.
    expect(decideDispatch(['/path/to/condash.bin', ''])).toEqual({
      kind: 'gui',
      argv: ['/path/to/condash.bin', ''],
    });
  });

  test('explicit `gui` → GUI with `gui` stripped', () => {
    expect(decideDispatch(['/path/to/condash.bin', 'gui'])).toEqual({
      kind: 'gui',
      argv: ['/path/to/condash.bin'],
    });
  });

  test('`gui` with Chromium switches → GUI with switches preserved', () => {
    expect(
      decideDispatch(['/path/to/condash.bin', 'gui', '--no-sandbox', '--enable-logging']),
    ).toEqual({
      kind: 'gui',
      argv: ['/path/to/condash.bin', '--no-sandbox', '--enable-logging'],
    });
  });

  test('a CLI noun → CLI dispatch', () => {
    expect(decideDispatch(['/path/to/condash.bin', 'projects', 'list'])).toEqual({
      kind: 'cli',
      cliArgs: ['projects', 'list'],
    });
  });

  test('`--help` (no prior `gui` token) → CLI dispatch', () => {
    // Rule C intentionally sends top-level --help to the CLI so the unified
    // top-help (GUI + CLI section) is the single source of truth.
    expect(decideDispatch(['/path/to/condash.bin', '--help'])).toEqual({
      kind: 'cli',
      cliArgs: ['--help'],
    });
  });

  test('bare `--no-sandbox` (without `gui`) → CLI dispatch (intentional break)', () => {
    // Pre-v2.24.0 this would silently launch the GUI with the Chromium switch;
    // rule C explicitly funnels it to the CLI so the user gets an unknown-flag
    // error and learns about the `condash gui ...` form.
    expect(decideDispatch(['/path/to/condash.bin', '--no-sandbox'])).toEqual({
      kind: 'cli',
      cliArgs: ['--no-sandbox'],
    });
  });
});
