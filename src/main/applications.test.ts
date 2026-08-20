import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addApplication,
  aliasIndex,
  fixAppsReferences,
  listApplications,
  renameApplication,
  renderAppsTable,
  resolveReference,
  rewriteAppsRefs,
  setApplication,
  syncAppsDocs,
  validateApplications,
} from './applications';

let tmp: string;
let emptyGlobal: string;

/** Write the conception's condash.json. workspace_path points at the temp
 *  tree so `path` resolution stays inside the sandbox. */
function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(
    join(tmp, 'condash.json'),
    JSON.stringify({ workspace_path: tmp, ...config }, null, 2) + '\n',
  );
}

function writeReadme(slug: string, apps: string[]): string {
  const dir = join(tmp, 'projects', '2026-05', slug);
  mkdirSync(dir, { recursive: true });
  const appsBlock = apps.length
    ? ['apps:', ...apps.map((a) => `  - ${/[#@~/]/.test(a) ? `"${a}"` : a}`)].join('\n')
    : 'apps: []';
  const readme = join(dir, 'README.md');
  writeFileSync(
    readme,
    [
      '---',
      'date: 2026-05-01',
      'kind: project',
      'status: now',
      appsBlock,
      '---',
      '',
      '# T',
      '',
    ].join('\n'),
  );
  return readme;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'condash-apps-'));
  emptyGlobal = join(tmp, 'empty-global.json');
  writeFileSync(emptyGlobal, '{}\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('listApplications', () => {
  it('derives a handle from the name and honours explicit handle + path', async () => {
    writeConfig({
      repositories: [
        'condash',
        { handle: 'kasten', path: 'notes.vcoeur.com', label: 'Kasten' },
        { name: 'PaintingManager' },
      ],
      retired_apps: [
        { handle: 'kasten-manager', label: 'KastenManager', aliases: ['KastenManager'] },
      ],
    });
    const apps = await listApplications(tmp, emptyGlobal);
    expect(apps.map((a) => a.handle)).toEqual([
      'condash',
      'kasten',
      'paintingmanager',
      'kasten-manager',
    ]);
    const kasten = apps.find((a) => a.handle === 'kasten')!;
    expect(kasten.path).toBe('notes.vcoeur.com');
    expect(kasten.dirName).toBe('notes.vcoeur.com');
    const retired = apps.find((a) => a.handle === 'kasten-manager')!;
    expect(retired.retired).toBe(true);
    expect(retired.path).toBeUndefined();
  });

  it('derives a handle from a Windows-style backslash path (C4)', async () => {
    writeConfig({ repositories: [{ path: 'vcoeur\\notes.vcoeur.com' }] });
    const apps = await listApplications(tmp, emptyGlobal);
    expect(apps.map((a) => a.handle)).toEqual(['notes.vcoeur.com']);
  });

  it('includes submodules as live apps carrying their parent handle (#335)', async () => {
    writeConfig({
      repositories: [
        {
          handle: 'parent-repo',
          name: 'parent-repo',
          submodules: [{ handle: 'child-a', name: 'child-a' }, 'ChildB'],
        },
        'standalone',
      ],
    });
    const apps = await listApplications(tmp, emptyGlobal);
    expect(apps.map((a) => a.handle)).toEqual(['parent-repo', 'child-a', 'childb', 'standalone']);
    const childA = apps.find((a) => a.handle === 'child-a')!;
    expect(childA.parent).toBe('parent-repo');
    expect(childA.path).toBe('parent-repo/child-a');
    expect(childA.retired).toBe(false);
    expect(apps.find((a) => a.handle === 'parent-repo')!.parent).toBeUndefined();
    expect(apps.find((a) => a.handle === 'standalone')!.parent).toBeUndefined();
  });
});

describe('aliasIndex + resolveReference', () => {
  it('resolves handle, alias, abs path, and unknown', async () => {
    mkdirSync(join(tmp, 'real-repo'));
    writeConfig({
      repositories: [{ handle: 'condash', name: 'condash', aliases: ['condash-electron'] }],
      retired_apps: [{ handle: 'kasten-manager', aliases: ['KastenManager'] }],
    });
    const records = await listApplications(tmp, emptyGlobal);
    const index = aliasIndex(records);

    expect((await resolveReference('#condash', records, index)).kind).toBe('handle');
    // The retired @ sigil no longer normalises away, so it fails to resolve.
    expect((await resolveReference('@condash', records, index)).kind).toBe('unknown');
    const alias = await resolveReference('condash-electron', records, index);
    expect(alias.kind).toBe('alias');
    expect(alias.canonical).toBe('condash');
    const retired = await resolveReference('KastenManager', records, index);
    expect(retired.kind).toBe('alias');
    expect(retired.retired).toBe(true);
    expect((await resolveReference(join(tmp, 'real-repo'), records, index)).kind).toBe('path');
    expect((await resolveReference('/nope/missing', records, index)).kind).toBe('unknown');
    expect((await resolveReference('ghostapp', records, index)).kind).toBe('unknown');
  });
});

describe('validateApplications', () => {
  it('flags unknown handles and suggests a rewrite for aliases', async () => {
    writeConfig({
      repositories: [{ handle: 'agentsconf', name: 'agentsconf', aliases: ['ClaudeConfig'] }],
    });
    writeReadme('2026-05-01-good', ['#agentsconf']);
    writeReadme('2026-05-02-alias', ['ClaudeConfig']);
    writeReadme('2026-05-03-bad', ['#ghost']);
    const issues = await validateApplications(tmp, emptyGlobal);
    const unknown = issues.filter((i) => i.problem === 'unknown-handle');
    const alias = issues.filter((i) => i.problem === 'alias');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].ref).toBe('#ghost');
    expect(alias).toHaveLength(1);
    expect(alias[0].suggestion).toBe('#agentsconf');
  });

  it('resolves a submodule handle referenced from a project README (#335)', async () => {
    writeConfig({
      repositories: [{ name: 'parent-repo', submodules: [{ handle: 'child-a', name: 'child-a' }] }],
    });
    writeReadme('2026-05-04-submodule', ['#child-a']);
    expect(await validateApplications(tmp, emptyGlobal)).toEqual([]);
  });
});

describe('renderAppsTable', () => {
  it('renders #handle / path / Purpose / AGENTS.md / knowledge rows for live apps only', async () => {
    writeConfig({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com', label: 'Kasten' }],
      retired_apps: [{ handle: 'kasten-manager' }],
    });
    // No checkout on disk → the AGENTS.md cell is empty; no `purpose` in the
    // registry → the Purpose cell is empty too.
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    expect(table).toContain('| App | Repo | Purpose | AGENTS.md | Knowledge |');
    expect(table).toContain(
      '| `#kasten` | `notes.vcoeur.com` |  |  | `knowledge/internal/kasten.md` |',
    );
    expect(table).not.toContain('kasten-manager');
  });

  it('renders the registry purpose in the Purpose cell', async () => {
    writeConfig({
      repositories: [
        { handle: 'kasten', path: 'notes.vcoeur.com', purpose: 'Zettelkasten vault and web UI' },
      ],
    });
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    expect(table).toContain('| `#kasten` | `notes.vcoeur.com` | Zettelkasten vault and web UI |');
  });

  it('keeps a purpose containing a pipe or newline inside its cell', async () => {
    writeConfig({
      repositories: [
        { handle: 'kasten', path: 'notes.vcoeur.com', purpose: 'notes | vault\nand web UI' },
      ],
    });
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    const row = table.split('\n').find((line) => line.includes('#kasten'))!;
    expect(row).toContain('notes \\| vault and web UI');
    // One row, five columns: the escaped pipe must not open a sixth cell, so
    // count only the delimiters that are not backslash-escaped.
    const delimiters = row.match(/(?<!\\)\|/g) ?? [];
    expect(delimiters.length - 1).toBe(5);
  });

  it('points the AGENTS.md cell at the resolved instruction file', async () => {
    writeConfig({ repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }] });
    const checkout = join(tmp, 'notes.vcoeur.com');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'AGENTS.md'), '# A\n');
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    expect(table).toContain(`\`${join(checkout, 'AGENTS.md')}\``);
  });

  it('falls back AGENTS.md → CLAUDE.md → .claude/CLAUDE.md', async () => {
    writeConfig({ repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }] });
    const checkout = join(tmp, 'notes.vcoeur.com');
    mkdirSync(join(checkout, '.claude'), { recursive: true });
    writeFileSync(join(checkout, '.claude', 'CLAUDE.md'), '# legacy\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal))).toContain(
      `\`${join(checkout, '.claude', 'CLAUDE.md')}\``,
    );
    // A top-level CLAUDE.md outranks the nested one.
    writeFileSync(join(checkout, 'CLAUDE.md'), '# legacy\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal))).toContain(
      `\`${join(checkout, 'CLAUDE.md')}\``,
    );
    // AGENTS.md outranks both.
    writeFileSync(join(checkout, 'AGENTS.md'), '# canonical\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal))).toContain(
      `\`${join(checkout, 'AGENTS.md')}\``,
    );
  });

  it('renders submodules nested under their parent (#335)', async () => {
    writeConfig({
      repositories: [
        {
          handle: 'parent-repo',
          name: 'parent-repo',
          submodules: [{ handle: 'child-a', name: 'child-a' }],
        },
      ],
    });
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    const rows = table.split('\n');
    const parentIdx = rows.findIndex((r) => r.includes('| `#parent-repo` |'));
    const childIdx = rows.findIndex((r) => r.includes('| ↳ `#child-a` |'));
    expect(parentIdx).toBeGreaterThan(-1);
    expect(childIdx).toBe(parentIdx + 1);
    expect(rows[childIdx]).toContain('`knowledge/internal/child-a.md`');
  });
});

describe('syncAppsDocs', () => {
  it('regenerates the table between sentinels and reports missing sentinels', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    const agents = join(tmp, 'AGENTS.md');

    writeFileSync(agents, '# A\n\n## Apps\n\nold table\n');
    expect((await syncAppsDocs(tmp)).missingSentinels).toBe(true);

    writeFileSync(
      agents,
      '# A\n\n## Apps\n\n<!-- condash:apps:start -->\nstale\n<!-- condash:apps:end -->\n\ntail\n',
    );
    const result = await syncAppsDocs(tmp);
    expect(result.changed).toBe(true);
    const body = readFileSync(agents, 'utf8');
    expect(body).toContain('| `#condash` |');
    expect(body).toContain('tail');
    // Second run is idempotent.
    expect((await syncAppsDocs(tmp)).changed).toBe(false);
  });
});

describe('rewriteAppsRefs', () => {
  it('maps bare and quoted list items, leaving the rest intact', () => {
    const raw = [
      '---',
      'apps:',
      '  - condash',
      '  - "#kasten"',
      '  - other',
      'branch: x',
      '---',
      '',
      '# body apps: not a block',
    ].join('\n');
    const out = rewriteAppsRefs(raw, (ref) => (ref === 'condash' ? '#condash' : ref));
    expect(out).toContain('  - "#condash"');
    expect(out).toContain('  - "#kasten"');
    expect(out).toContain('branch: x');
    expect(out).toContain('# body apps: not a block');
  });

  it('never rewrites an `apps:` example in the README body (fenced or not)', () => {
    const header = ['---', 'apps:', '  - condash', '---'].join('\n');
    const body = [
      '',
      '# Title',
      '',
      'Example of a header:',
      '',
      '```yaml',
      'apps:',
      '  - condash',
      '  - vcoeur',
      '```',
      '',
      'apps:',
      '  - condash (a bullet that merely looks like a list item)',
      '',
    ].join('\n');
    const out = rewriteAppsRefs(header + body, (ref) =>
      ref.startsWith('condash') ? '#renamed' : ref,
    );
    // Front-matter rewritten, body byte-identical.
    const expectedHeader = ['---', 'apps:', '  - "#renamed"', '---'].join('\n');
    expect(out).toBe(expectedHeader + body);
  });

  it('returns the input untouched when there is no closed front-matter', () => {
    const noFm = ['# Title', '', 'apps:', '  - condash'].join('\n');
    expect(rewriteAppsRefs(noFm, () => '#x')).toBe(noFm);
    const unclosed = ['---', 'apps:', '  - condash'].join('\n');
    expect(rewriteAppsRefs(unclosed, () => '#x')).toBe(unclosed);
  });

  it('a blank line inside the front-matter terminates the apps block', () => {
    const raw = ['---', 'apps:', '  - condash', '', '  - stray', '---'].join('\n');
    const out = rewriteAppsRefs(raw, (ref) => (ref === 'condash' ? '#c' : `#mapped-${ref}`));
    expect(out).toContain('  - "#c"');
    expect(out).toContain('  - stray');
    expect(out).not.toContain('mapped');
  });
});

describe('fixAppsReferences', () => {
  it('canonicalises bare names and aliases, leaving unknowns for a human', async () => {
    writeConfig({
      repositories: [
        { handle: 'condash', name: 'condash' },
        { handle: 'agentsconf', name: 'agentsconf', aliases: ['ClaudeConfig'] },
      ],
    });
    writeReadme('2026-05-01-mix', ['condash', 'ClaudeConfig', 'ghost']);
    const result = await fixAppsReferences(tmp, emptyGlobal);
    expect(result.readmesRewritten).toHaveLength(1);
    expect(result.unresolved.map((u) => u.ref)).toEqual(['ghost']);
    const readme = readFileSync(
      join(tmp, 'projects', '2026-05', '2026-05-01-mix', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('- "#condash"');
    expect(readme).toContain('- "#agentsconf"');
    expect(readme).toContain('- ghost');
  });
});

describe('add / set / rename round-trips', () => {
  it('registers, updates, and renames with README cascade', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    writeReadme('2026-05-01-uses-fovea', ['#fovea']);

    await addApplication(tmp, { handle: 'fovea', path: 'fovea', label: 'Fovea' });
    let apps = await listApplications(tmp, emptyGlobal);
    expect(apps.find((a) => a.handle === 'fovea')?.path).toBe('fovea');

    await setApplication(tmp, 'fovea', { label: 'Fovea App' });
    apps = await listApplications(tmp, emptyGlobal);
    expect(apps.find((a) => a.handle === 'fovea')?.label).toBe('Fovea App');

    const result = await renameApplication(tmp, 'fovea', 'fovea-web');
    expect(result.readmesRewritten).toHaveLength(1);
    apps = await listApplications(tmp, emptyGlobal);
    const renamed = apps.find((a) => a.handle === 'fovea-web')!;
    expect(renamed.aliases).toContain('fovea');
    const readme = readFileSync(
      join(tmp, 'projects', '2026-05', '2026-05-01-uses-fovea', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('#fovea-web');
  });

  it('rejects a duplicate handle on add', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    await expect(addApplication(tmp, { handle: 'condash', path: 'x' })).rejects.toThrow(/exists/);
  });

  it('rejects adding an app whose handle collides with a submodule (#335)', async () => {
    writeConfig({
      repositories: [{ name: 'parent-repo', submodules: [{ handle: 'child-a', name: 'child-a' }] }],
    });
    await expect(addApplication(tmp, { handle: 'child-a', path: 'x' })).rejects.toThrow(/exists/);
  });

  it('rejects renaming onto another app’s handle or alias', async () => {
    writeConfig({
      repositories: [
        { handle: 'condash', name: 'condash' },
        { handle: 'fovea', name: 'fovea', aliases: ['fovea-legacy'] },
      ],
      retired_apps: [{ handle: 'kasten-manager' }],
    });
    await expect(renameApplication(tmp, 'condash', 'fovea')).rejects.toThrow(
      /already exists.*#fovea/,
    );
    await expect(renameApplication(tmp, 'condash', 'fovea-legacy')).rejects.toThrow(
      /already exists.*#fovea/,
    );
    await expect(renameApplication(tmp, 'condash', 'kasten-manager')).rejects.toThrow(
      /already exists/,
    );
    // Nothing was mutated by the refused renames.
    const apps = await listApplications(tmp, emptyGlobal);
    expect(apps.map((a) => a.handle)).toEqual(['condash', 'fovea', 'kasten-manager']);
  });

  it('allows renaming an app back onto one of its OWN aliases', async () => {
    writeConfig({
      repositories: [{ handle: 'fovea-web', name: 'fovea', aliases: ['fovea'] }],
    });
    await renameApplication(tmp, 'fovea-web', 'fovea');
    const apps = await listApplications(tmp, emptyGlobal);
    const renamed = apps.find((a) => a.handle === 'fovea')!;
    expect(renamed).toBeDefined();
    // The old handle became an alias; the app does not alias itself.
    expect(renamed.aliases).toContain('fovea-web');
    expect(renamed.aliases).not.toContain('fovea');
  });

  it('sets label, purpose and path on a submodule handle (#532)', async () => {
    writeConfig({
      repositories: [
        { handle: 'alpha', path: 'alpha', label: 'Alpha' },
        {
          handle: 'beta',
          path: 'beta',
          label: 'Beta',
          submodules: [{ handle: 'gamma', path: 'gamma', label: 'Gamma' }],
        },
      ],
    });
    await setApplication(tmp, 'gamma', {
      label: 'Gamma Renamed',
      purpose: 'the nested one',
      path: 'gamma-moved',
    });
    const apps = await listApplications(tmp, emptyGlobal);
    const gamma = apps.find((a) => a.handle === 'gamma')!;
    expect(gamma.label).toBe('Gamma Renamed');
    expect(gamma.purpose).toBe('the nested one');
    expect(gamma.parent).toBe('beta');
    // The patch lands on the submodule, never on its parent.
    expect(apps.find((a) => a.handle === 'beta')!.label).toBe('Beta');
  });

  it('renames a submodule handle in place, keeping it under its parent (#532)', async () => {
    writeConfig({
      repositories: [
        { handle: 'beta', path: 'beta', submodules: [{ handle: 'gamma', path: 'gamma' }] },
      ],
    });
    writeReadme('2026-05-05-uses-gamma', ['#gamma']);

    const result = await renameApplication(tmp, 'gamma', 'delta');
    expect(result.readmesRewritten).toHaveLength(1);

    const apps = await listApplications(tmp, emptyGlobal);
    const delta = apps.find((a) => a.handle === 'delta')!;
    expect(delta.parent).toBe('beta');
    expect(delta.aliases).toContain('gamma');
    // Still nested — the rename must not promote it to a top-level entry.
    expect(apps.map((a) => a.handle)).toEqual(['beta', 'delta']);
  });

  it('reports a genuinely absent handle, submodules searched (#532)', async () => {
    writeConfig({
      repositories: [
        { handle: 'beta', path: 'beta', submodules: [{ handle: 'gamma', path: 'gamma' }] },
      ],
    });
    await expect(setApplication(tmp, 'nope', { label: 'x' })).rejects.toThrow(/no live app #nope/);
  });

  it('edits the namesake declaration order resolves to, nested first (#532)', async () => {
    // The nested namesake is declared FIRST, so it is the row `list` reports
    // first and `resolveReference` resolves `#shared` to. `set` must edit that
    // same row — a top-level-first rule would silently patch the other one.
    writeConfig({
      repositories: [
        { handle: 'beta', path: 'beta', submodules: [{ name: 'shared', label: 'Nested' }] },
        { handle: 'shared', path: 'top-level', label: 'Top' },
      ],
    });
    const before = await listApplications(tmp, emptyGlobal);
    expect((await resolveReference('#shared', before, aliasIndex(before))).canonical).toBe(
      'shared',
    );
    expect(before.find((a) => a.handle === 'shared')!.parent).toBe('beta');

    await setApplication(tmp, 'shared', { label: 'Patched' });
    const apps = await listApplications(tmp, emptyGlobal);
    expect(apps.find((a) => a.handle === 'shared' && a.parent)!.label).toBe('Patched');
    expect(apps.find((a) => a.handle === 'shared' && !a.parent)!.label).toBe('Top');
  });

  it('normalises an explicitly written handle, so read and write agree (#532)', async () => {
    // A raw `handle: "Kasten"` used to be published un-normalised while every
    // reference resolves through appHandle, so `list` showed #Kasten,
    // `validate` called #kasten unknown, and `set kasten` edited it anyway.
    writeConfig({ repositories: [{ handle: 'Kasten', path: 'notes' }] });
    writeReadme('2026-05-06-uses-kasten', ['kasten']);
    expect((await listApplications(tmp, emptyGlobal)).map((a) => a.handle)).toEqual(['kasten']);
    expect(await validateApplications(tmp, emptyGlobal)).toEqual([]);
    await setApplication(tmp, 'kasten', { label: 'Kasten notes' });
    expect((await listApplications(tmp, emptyGlobal))[0].label).toBe('Kasten notes');
  });

  it('reaches a handle nested more than one level deep (#532)', async () => {
    // The zod schema forbids nesting a submodule under a submodule, and
    // `{handle:'deep'}` alone would also fail the "needs a name or path"
    // rule — this fixture is deliberately not a supported shape. It is here
    // only to probe that the walk is depth-independent, which it must be
    // because the mutation path reads raw JSON with no schema validation and
    // a hand-edited settings file is exactly the #532 scenario.
    writeConfig({
      repositories: [
        {
          handle: 'beta',
          path: 'beta',
          submodules: [{ handle: 'gamma', path: 'gamma', submodules: [{ handle: 'deep' }] }],
        },
      ],
    });
    expect((await listApplications(tmp, emptyGlobal)).map((a) => a.handle)).toContain('deep');
    await setApplication(tmp, 'deep', { label: 'Deep' });
    expect((await listApplications(tmp, emptyGlobal)).find((a) => a.handle === 'deep')!.label).toBe(
      'Deep',
    );
  });

  it('sets and renames a bare-string entry nested in submodules[] (#532)', async () => {
    writeConfig({ repositories: [{ handle: 'beta', path: 'beta', submodules: ['gamma'] }] });
    await setApplication(tmp, 'gamma', { label: 'Gamma' });
    let apps = await listApplications(tmp, emptyGlobal);
    expect(apps.find((a) => a.handle === 'gamma')!.label).toBe('Gamma');
    expect(apps.find((a) => a.handle === 'gamma')!.parent).toBe('beta');

    await renameApplication(tmp, 'gamma', 'delta');
    apps = await listApplications(tmp, emptyGlobal);
    const delta = apps.find((a) => a.handle === 'delta')!;
    expect(delta.parent).toBe('beta');
    expect(delta.aliases).toContain('gamma');
  });

  it('interprets a submodule --path against its parent directory (#532)', async () => {
    // resolveCwd anchors a submodule's relative path on the parent's resolved
    // cwd, so `--path gamma-moved` means <workspace>/beta/gamma-moved. `list`
    // then prints that workspace-relative, which is NOT the value to feed back
    // to --path. Pinned so the asymmetry cannot drift unnoticed.
    writeConfig({
      repositories: [
        { handle: 'beta', path: 'beta', submodules: [{ handle: 'gamma', path: 'gamma' }] },
      ],
    });
    await setApplication(tmp, 'gamma', { path: 'gamma-moved' });
    const apps = await listApplications(tmp, emptyGlobal);
    const gamma = apps.find((a) => a.handle === 'gamma')!;
    expect(gamma.cwd).toBe(join(tmp, 'beta', 'gamma-moved'));
    expect(gamma.path).toBe('beta/gamma-moved');
  });

  it('upgrades a bare-string entry so set can reach it (#532)', async () => {
    writeConfig({ repositories: ['delta'] });
    await setApplication(tmp, 'delta', { label: 'Delta', purpose: 'was a bare string' });
    const apps = await listApplications(tmp, emptyGlobal);
    const delta = apps.find((a) => a.handle === 'delta')!;
    expect(delta.label).toBe('Delta');
    expect(delta.purpose).toBe('was a bare string');
    // The handle is unchanged by the widening — it still derives from the name.
    expect(apps.map((a) => a.handle)).toEqual(['delta']);
    // Mutations land in the canonical `.condash/settings.json`, seeded from
    // the legacy file writeConfig created.
    const written = JSON.parse(readFileSync(join(tmp, '.condash', 'settings.json'), 'utf8')) as {
      repositories: unknown[];
    };
    expect(written.repositories[0]).toMatchObject({ name: 'delta', label: 'Delta' });
  });
});

describe('resolveReference tilde handling', () => {
  it('resolves bare `~` and `~/...`, and treats `~user` as unknown', async () => {
    writeConfig({ repositories: [] });
    const records = await listApplications(tmp, emptyGlobal);
    const index = aliasIndex(records);
    // Bare `~` — the home directory itself exists.
    expect((await resolveReference('~', records, index)).kind).toBe('path');
    // `~/…` that cannot exist.
    expect(
      (await resolveReference('~/condash-test-definitely-missing-xyz', records, index)).kind,
    ).toBe('unknown');
    // `~user` would need a passwd lookup — must not be mangled into
    // `<home>/ser/...`; reported unknown instead.
    expect((await resolveReference('~root/whatever', records, index)).kind).toBe('unknown');
  });
});
