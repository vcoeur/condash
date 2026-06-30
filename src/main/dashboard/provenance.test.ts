import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONDASH_DIR, condashSettingsPath } from '../condash-dir';
import { deriveProvenance } from './provenance';

let tmp: string;
let worktrees: string;
let prevXdg: string | undefined;

/** Write a project README with a YAML frontmatter `branch:` and an H1 title. */
function writeProject(slug: string, branch: string, title: string): void {
  const dir = join(tmp, 'projects', '2026-06', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'README.md'),
    `---\ndate: 2026-06-30\nkind: project\nstatus: now\nbranch: ${branch}\n---\n\n# ${title}\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-prov-'));
  worktrees = join(tmp, 'wt');
  // Keep the global settings read hermetic — point XDG at an empty dir so no
  // machine settings.json bleeds into the effective config.
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmp, 'xdg');
  mkdirSync(join(tmp, CONDASH_DIR), { recursive: true });
  writeFileSync(
    condashSettingsPath(tmp),
    JSON.stringify({
      workspace_path: join(tmp, 'src'),
      worktrees_path: worktrees,
      // A custom-handle repo (dir `vcoeur.com` → handle `vcoeur`) plus a plain
      // string repo whose handle is its name.
      repositories: [{ handle: 'vcoeur', path: 'vcoeur.com' }, 'condash'],
    }),
  );
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmp, { recursive: true, force: true });
});

describe('deriveProvenance', () => {
  it('maps the tab repo to its canonical #handle via the registry', async () => {
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(tmp, 'src', 'vcoeur.com'),
      repo: 'vcoeur.com',
    });
    expect(prov.app).toBe('vcoeur');
  });

  it('leaves app undefined for a tab with no repo or an unknown repo', async () => {
    expect((await deriveProvenance(tmp, { sid: 'a', cwd: '/x' })).app).toBeUndefined();
    expect(
      (await deriveProvenance(tmp, { sid: 'a', cwd: '/x', repo: 'nope' })).app,
    ).toBeUndefined();
  });

  it('derives the worktree segment when cwd is under worktrees_path', async () => {
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(worktrees, 'my-branch', 'condash', 'src'),
      repo: 'condash',
    });
    expect(prov.app).toBe('condash');
    expect(prov.worktree).toBe('my-branch');
  });

  it('leaves worktree undefined for a cwd outside worktrees_path', async () => {
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(tmp, 'src', 'condash'),
      repo: 'condash',
    });
    expect(prov.worktree).toBeUndefined();
    expect(prov.projects).toBeUndefined();
  });

  it('fills projects[] from READMEs whose branch maps to the worktree', async () => {
    writeProject('2026-06-30-redesign', 'my-branch', 'Dashboard redesign');
    writeProject('2026-06-30-other', 'different-branch', 'Other work');
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(worktrees, 'my-branch', 'condash'),
      repo: 'condash',
    });
    expect(prov.projects).toEqual([{ slug: '2026-06-30-redesign', title: 'Dashboard redesign' }]);
  });

  it('matches a slash branch against its flattened worktree directory', async () => {
    writeProject('2026-06-30-feat', 'feature/x', 'Feature X');
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(worktrees, 'feature-x', 'condash'),
      repo: 'condash',
    });
    expect(prov.worktree).toBe('feature-x');
    expect(prov.projects).toEqual([{ slug: '2026-06-30-feat', title: 'Feature X' }]);
  });

  it('leaves projects undefined when the worktree matches no README branch', async () => {
    writeProject('2026-06-30-redesign', 'some-other-branch', 'Redesign');
    const prov = await deriveProvenance(tmp, {
      sid: 'a',
      cwd: join(worktrees, 'my-branch', 'condash'),
      repo: 'condash',
    });
    expect(prov.projects).toBeUndefined();
  });
});
