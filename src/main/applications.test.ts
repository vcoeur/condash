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
});

describe('renderAppsTable', () => {
  it('renders #handle / path / AGENTS.md / knowledge rows for live apps only', async () => {
    writeConfig({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com', label: 'Kasten' }],
      retired_apps: [{ handle: 'kasten-manager' }],
    });
    // No checkout on disk → the AGENTS.md cell is empty.
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal));
    expect(table).toContain('| App | Repo | AGENTS.md | Knowledge |');
    expect(table).toContain(
      '| `#kasten` | `notes.vcoeur.com` |  | `knowledge/internal/kasten.md` |',
    );
    expect(table).not.toContain('kasten-manager');
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
});
