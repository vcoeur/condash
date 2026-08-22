import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initConception,
  substituteTemplateTokens,
  assertInitTargetAllowed,
} from './conception-init';

/** Where the fake bundled template lives — set per test. */
const mockAppPath = vi.hoisted(() => ({ value: '' }));

vi.mock('electron', () => ({
  app: { getAppPath: () => mockAppPath.value },
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-init-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('substituteTemplateTokens', () => {
  it('fills the name and description tokens', () => {
    const text = '# AGENTS.md — {{ conception_name }}\n\n{{ description }}\n';
    expect(
      substituteTemplateTokens(text, 'my-tree', 'Conception at /x/my-tree — managed by condash.'),
    ).toBe('# AGENTS.md — my-tree\n\nConception at /x/my-tree — managed by condash.\n');
  });

  it('leaves other tokens and token-free text alone', () => {
    expect(substituteTemplateTokens('{{ conception_name }} {{ other_token }}', 'n', 'd')).toBe(
      'n {{ other_token }}',
    );
    expect(substituteTemplateTokens('plain text', 'n', 'd')).toBe('plain text');
  });
});

describe('initConception', () => {
  /** Lay a minimal fake template at `<appRoot>/conception-template` and
   *  point the mocked `app.getAppPath()` at the app root. */
  function setupTemplate(): string {
    const template = join(tmp, 'app-root', 'conception-template');
    mkdirSync(join(template, 'projects'), { recursive: true });
    writeFileSync(
      join(template, 'AGENTS.md'),
      '# AGENTS.md — {{ conception_name }}\n\n{{ description }}\n',
    );
    writeFileSync(join(template, 'projects', 'index.md'), '# Projects\n');
    mockAppPath.value = join(tmp, 'app-root');
    return template;
  }

  it('substitutes the AGENTS.md tokens in the copied tree', async () => {
    setupTemplate();
    const target = join(tmp, 'target', 'my-conception');
    await initConception(target);
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe(
      `# AGENTS.md — my-conception\n\nConception at ${target} — projects and knowledge managed by condash.\n`,
    );
    expect(readFileSync(join(target, 'projects', 'index.md'), 'utf8')).toBe('# Projects\n');
  });

  it('preserves an existing AGENTS.md without substituting', async () => {
    setupTemplate();
    const target = join(tmp, 'existing');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'AGENTS.md'), '# Hand-made AGENTS.md — {{ conception_name }}\n');
    await initConception(target);
    expect(readFileSync(join(target, 'AGENTS.md'), 'utf8')).toBe(
      '# Hand-made AGENTS.md — {{ conception_name }}\n',
    );
  });
});

describe('assertInitTargetAllowed', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'condash-init-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows the dialog-picked existing directory', async () => {
    await expect(assertInitTargetAllowed(dir, dir)).resolves.toBeUndefined();
  });

  it('rejects when no dialog pick is outstanding', async () => {
    await expect(assertInitTargetAllowed(dir, null)).rejects.toThrow(
      /not picked via the conception dialog/,
    );
  });

  it('rejects a path other than the dialog pick', async () => {
    await expect(assertInitTargetAllowed(dir, join(dir, 'other'))).rejects.toThrow(
      /not picked via the conception dialog/,
    );
  });

  it('rejects a picked path that does not exist as a directory', async () => {
    const missing = join(dir, 'nope');
    await expect(assertInitTargetAllowed(missing, missing)).rejects.toThrow(/not a directory/);
  });
});
