import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addApplication,
  aliasIndex,
  asTablePath,
  exportAppsRegistry,
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
  it('renders #handle / path / AGENTS.md / knowledge rows for live apps only', async () => {
    writeConfig({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com', label: 'Kasten' }],
      retired_apps: [{ handle: 'kasten-manager' }],
    });
    // No checkout on disk → the AGENTS.md cell is empty.
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp);
    expect(table).toContain('| App | Repo | AGENTS.md | Knowledge |');
    expect(table).toContain(
      '| `#kasten` | `notes.vcoeur.com` |  | `knowledge/internal/kasten.md` |',
    );
    expect(table).not.toContain('kasten-manager');
  });

  it('renders the AGENTS.md cell relative to the workspace root (#575)', async () => {
    writeConfig({ repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }] });
    const checkout = join(tmp, 'notes.vcoeur.com');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'AGENTS.md'), '# A\n');
    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp);
    expect(table).toContain('`notes.vcoeur.com/AGENTS.md`');
    // Never the absolute, home-embedding form.
    expect(table).not.toContain(checkout);
  });

  it('renders an out-of-workspace repo’s AGENTS.md cell verbatim', async () => {
    // resolveCwd passes an absolute configured path through as-is, so the
    // instruction file sits outside the workspace root — there is no
    // workspace-relative form, so the path renders as-is.
    const outside = mkdtempSync(join(tmpdir(), 'condash-apps-outside-'));
    try {
      writeFileSync(join(outside, 'AGENTS.md'), '# A\n');
      writeConfig({ repositories: [{ handle: 'external', path: outside }] });
      const table = await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp);
      expect(table).toContain(`\`${join(outside, 'AGENTS.md')}\``);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('falls back AGENTS.md → CLAUDE.md → .claude/CLAUDE.md, rendered workspace-relative', async () => {
    writeConfig({ repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }] });
    const checkout = join(tmp, 'notes.vcoeur.com');
    mkdirSync(join(checkout, '.claude'), { recursive: true });
    writeFileSync(join(checkout, '.claude', 'CLAUDE.md'), '# legacy\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp)).toContain(
      '`notes.vcoeur.com/.claude/CLAUDE.md`',
    );
    // A top-level CLAUDE.md outranks the nested one.
    writeFileSync(join(checkout, 'CLAUDE.md'), '# legacy\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp)).toContain(
      '`notes.vcoeur.com/CLAUDE.md`',
    );
    // AGENTS.md outranks both.
    writeFileSync(join(checkout, 'AGENTS.md'), '# canonical\n');
    expect(await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp)).toContain(
      '`notes.vcoeur.com/AGENTS.md`',
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

describe('asTablePath', () => {
  it('renders a backslash-separated Windows path workspace-relative (#575)', () => {
    // On Windows, resolve() yields backslash paths; a native-separator
    // prefix check would never match and the cell would silently render
    // absolute. Both sides compare in posix form.
    expect(asTablePath('C:\\ws\\repo\\AGENTS.md', 'C:\\ws')).toBe('repo/AGENTS.md');
    // The verbatim (out-of-workspace) case also renders forward-slash form.
    expect(asTablePath('D:\\elsewhere\\repo\\AGENTS.md', 'C:\\ws')).toBe(
      'D:/elsewhere/repo/AGENTS.md',
    );
    // POSIX paths are already posix form — unchanged.
    expect(asTablePath('/home/you/ws/repo/AGENTS.md', '/home/you/ws')).toBe('repo/AGENTS.md');
    expect(asTablePath('', '/home/you/ws')).toBe('');
  });
});

describe('committed registry (condash-apps.json)', () => {
  /** Write the committed registry file at the conception root. */
  function writeCommittedRegistry(body: Record<string, unknown>): void {
    writeFileSync(join(tmp, 'condash-apps.json'), JSON.stringify(body, null, 2) + '\n');
  }

  function writeAgentsMd(): string {
    const agents = join(tmp, 'AGENTS.md');
    writeFileSync(
      agents,
      '# A\n\n<!-- condash:apps:start -->\nstale\n<!-- condash:apps:end -->\n\ntail\n',
    );
    return agents;
  }

  it('generates the table from the committed file, ignoring per-machine settings (#575)', async () => {
    // The settings registry describes a DIFFERENT set of apps than the
    // committed file — exactly the second-machine drift the file exists to
    // kill. The table must follow the committed file only.
    writeConfig({
      repositories: [{ handle: 'from-settings', name: 'from-settings' }],
      retired_apps: [{ handle: 'retired-settings' }],
    });
    writeCommittedRegistry({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }],
      retired_apps: [{ handle: 'retired-committed' }],
    });
    const agents = writeAgentsMd();
    const result = await syncAppsDocs(tmp);
    expect(result.changed).toBe(true);
    const body = readFileSync(agents, 'utf8');
    expect(body).toContain('| App | Repo | AGENTS.md | Knowledge |');
    expect(body).toContain('| `#kasten` | `notes.vcoeur.com` |');
    expect(body).not.toContain('from-settings');
    expect(body).not.toContain('retired-settings');
    // Retired handles never render; the committed file's retired list is the
    // sole source, so a settings-only retired handle cannot leak in either.
    expect(body).not.toContain('kasten-manager');
  });

  it('renders the committed file’s AGENTS.md cells workspace-relative', async () => {
    writeConfig({ repositories: [{ handle: 'unrelated', name: 'unrelated' }] });
    writeCommittedRegistry({
      repositories: [{ handle: 'kasten', path: 'notes.vcoeur.com' }],
    });
    const checkout = join(tmp, 'notes.vcoeur.com');
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'AGENTS.md'), '# A\n');
    const agents = writeAgentsMd();
    await syncAppsDocs(tmp);
    const body = readFileSync(agents, 'utf8');
    expect(body).toContain('`notes.vcoeur.com/AGENTS.md`');
    expect(body).not.toContain(checkout);
  });

  it('without the file, the table still comes from the settings registry', async () => {
    writeConfig({
      repositories: [{ handle: 'from-settings', name: 'from-settings' }],
      retired_apps: [{ handle: 'retired-settings' }],
    });
    const agents = writeAgentsMd();
    await syncAppsDocs(tmp);
    const body = readFileSync(agents, 'utf8');
    expect(body).toContain('| `#from-settings` |');
    expect(body).not.toContain('kasten');
    expect(body).not.toContain('retired-settings');
  });

  it('rejects an invalid committed registry with a clear error, block untouched', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    const agents = writeAgentsMd();
    const before = readFileSync(agents, 'utf8');

    // Not an array.
    writeCommittedRegistry({ repositories: 'nope' } as unknown as Record<string, unknown>);
    await expect(syncAppsDocs(tmp)).rejects.toThrow(/condash-apps\.json: repositories/);
    // A per-machine key has no place in a committed file — `.strict()`
    // rejects it at the root.
    writeCommittedRegistry({ workspace_path: tmp });
    await expect(syncAppsDocs(tmp)).rejects.toThrow(
      /condash-apps\.json: <root> — Unrecognized key: "workspace_path"/,
    );
    // Malformed JSON.
    writeFileSync(join(tmp, 'condash-apps.json'), '{oops');
    await expect(syncAppsDocs(tmp)).rejects.toThrow(/condash-apps\.json: invalid JSON/);

    expect(readFileSync(agents, 'utf8')).toBe(before);
  });

  it('export writes a registry that round-trips into the same table (#575)', async () => {
    writeConfig({
      repositories: [
        { section: 'Services' },
        { handle: 'condash', name: 'condash' },
        {
          handle: 'beta',
          path: 'beta',
          aliases: ['BetaLegacy'],
          submodules: [{ handle: 'gamma', path: 'gamma' }],
        },
      ],
      retired_apps: [{ handle: 'old-app', aliases: ['OldApp'] }],
    });
    const agents = writeAgentsMd();
    await syncAppsDocs(tmp);
    const tableFromSettings = readFileSync(agents, 'utf8');

    const result = await exportAppsRegistry(tmp);
    expect(result.file).toBe(join(tmp, 'condash-apps.json'));
    expect(result.live).toBe(3);
    expect(result.retired).toBe(1);
    // The export carries only the registry keys — no per-machine field.
    const written = JSON.parse(readFileSync(result.file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['repositories', 'retired_apps']);

    // A second machine's settings: a different registry entirely. The table
    // must not move.
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ workspace_path: tmp, repositories: [{ handle: 'other', name: 'other' }] }),
    );
    await syncAppsDocs(tmp);
    expect(readFileSync(agents, 'utf8')).toBe(tableFromSettings);
  });

  it('export overwrites an existing committed registry with the current settings (#575)', async () => {
    writeConfig({ repositories: [{ handle: 'old-row', name: 'old-row' }] });
    const agents = writeAgentsMd();
    await syncAppsDocs(tmp);
    expect(readFileSync(agents, 'utf8')).toContain('| `#old-row` |');

    // The tree adopts the committed file, then the registry moves on. The
    // refresh contract: --export replaces the file wholesale with the
    // current settings registry (its own bytes validated before the write),
    // and the regenerated table follows.
    writeCommittedRegistry({ repositories: [{ handle: 'old-row', name: 'old-row' }] });
    writeConfig({ repositories: [{ handle: 'new-row', name: 'new-row' }] });
    await exportAppsRegistry(tmp);

    expect(JSON.parse(readFileSync(join(tmp, 'condash-apps.json'), 'utf8'))).toEqual({
      repositories: [{ handle: 'new-row', name: 'new-row' }],
      retired_apps: [],
    });
    await syncAppsDocs(tmp);
    const body = readFileSync(agents, 'utf8');
    expect(body).toContain('| `#new-row` |');
    expect(body).not.toContain('old-row');
  });

  it('export refuses to write a body the committed-file schema would reject', async () => {
    // The mutation path reads raw JSON without schema validation, so a
    // hand-edited registry can carry a shape the settings reader tolerates
    // but the committed file must not. Export surfaces it instead of landing
    // a file the next sync-docs refuses.
    writeFileSync(
      join(tmp, 'condash.json'),
      JSON.stringify({ workspace_path: tmp, repositories: [{ bogus: true }] }),
    );
    await expect(exportAppsRegistry(tmp)).rejects.toThrow(/condash-apps\.json/);
    expect(() => readFileSync(join(tmp, 'condash-apps.json'), 'utf8')).toThrow();
  });
});

describe('committed registry auto-refresh (#628 follow-up)', () => {
  function readCommitted(): string {
    return readFileSync(join(tmp, 'condash-apps.json'), 'utf8');
  }

  function writeCommittedRegistry(body: Record<string, unknown>): void {
    writeFileSync(join(tmp, 'condash-apps.json'), JSON.stringify(body, null, 2) + '\n');
  }

  it('add / set / rename refresh an existing committed registry in the same operation', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    writeCommittedRegistry({
      repositories: [{ handle: 'condash', name: 'condash' }],
      retired_apps: [],
    });

    await addApplication(tmp, { handle: 'fovea', path: 'fovea' });
    expect(JSON.parse(readCommitted())).toEqual({
      repositories: [
        { handle: 'condash', name: 'condash' },
        { handle: 'fovea', path: 'fovea' },
      ],
      retired_apps: [],
    });

    await setApplication(tmp, 'fovea', { label: 'Fovea' });
    expect(JSON.parse(readCommitted())).toMatchObject({
      repositories: [{}, { handle: 'fovea', path: 'fovea', label: 'Fovea' }],
    });

    await renameApplication(tmp, 'fovea', 'fovea-web');
    expect(JSON.parse(readCommitted())).toMatchObject({
      repositories: [{}, { handle: 'fovea-web', aliases: ['fovea'] }],
    });
  });

  it('a rejected mutation leaves the committed file untouched', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });
    writeCommittedRegistry({ repositories: [{ handle: 'condash', name: 'condash' }] });
    const before = readCommitted();

    await expect(addApplication(tmp, { handle: 'condash', path: 'x' })).rejects.toThrow(/exists/);
    await expect(setApplication(tmp, 'ghost', { label: 'x' })).rejects.toThrow(
      /no live app #ghost/,
    );

    expect(readCommitted()).toBe(before);
  });

  it('without the committed file, add/set/rename create nothing', async () => {
    writeConfig({ repositories: [{ handle: 'condash', name: 'condash' }] });

    await addApplication(tmp, { handle: 'fovea', path: 'fovea' });
    await setApplication(tmp, 'fovea', { label: 'Fovea' });
    await renameApplication(tmp, 'fovea', 'fovea-web');

    expect(() => readCommitted()).toThrow();
  });

  it('a settings registry carrying purpose still validates and generates the same table', async () => {
    writeConfig({
      repositories: [
        { handle: 'kasten', path: 'notes.vcoeur.com', purpose: 'personal zettelkasten' },
      ],
    });

    const table = await renderAppsTable(await listApplications(tmp, emptyGlobal), tmp);
    // The four-column shape, and the purpose value never renders.
    expect(table).toContain('| App | Repo | AGENTS.md | Knowledge |');
    expect(table).toContain('| `#kasten` | `notes.vcoeur.com` |');
    expect(table).not.toContain('zettelkasten');

    // The field keeps round-tripping through --export — the schema still
    // accepts it (deprecated, not removed).
    await exportAppsRegistry(tmp);
    const written = JSON.parse(readCommitted()) as { repositories: Array<Record<string, unknown>> };
    expect(written.repositories[0]).toMatchObject({
      handle: 'kasten',
      purpose: 'personal zettelkasten',
    });
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

  it('rejects an empty path before writing and preserves the raw config', async () => {
    writeConfig({ repositories: [{ handle: 'gamma', path: 'gamma' }] });
    const configPath = join(tmp, 'condash.json');
    const before = readFileSync(configPath, 'utf8');

    await expect(setApplication(tmp, 'gamma', { path: '' })).rejects.toThrow(
      /path must be non-empty.*locator/,
    );

    expect(readFileSync(configPath, 'utf8')).toBe(before);
    expect(() => readFileSync(join(tmp, '.condash', 'settings.json'), 'utf8')).toThrow();
  });

  it('writes a valid path mutation that passes the conception schema', async () => {
    writeConfig({ repositories: [{ handle: 'gamma', path: 'gamma' }] });

    await setApplication(tmp, 'gamma', { path: 'gamma-moved' });

    const written = readFileSync(join(tmp, '.condash', 'settings.json'), 'utf8');
    const { conceptionConfigSchema } = await import('./config-schema');
    expect(conceptionConfigSchema.safeParse(JSON.parse(written)).success).toBe(true);
    expect(JSON.parse(written)).toMatchObject({
      repositories: [{ handle: 'gamma', path: 'gamma-moved' }],
    });
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
