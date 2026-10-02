import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConception } from './conception';

const settings = vi.hoisted(() => ({ lastConceptionPath: '' }));
vi.mock('../main/settings', () => ({ readSettings: vi.fn(async () => settings) }));

describe('CLI conception resolution', () => {
  let root: string;
  let fallback: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'condash-resolver-'));
    fallback = await tree('fallback');
    vi.spyOn(process, 'cwd').mockReturnValue(fallback);
    vi.stubEnv('CONDASH_CONCEPTION_PATH', undefined);
    vi.stubEnv('CONDASH_CONCEPTION', undefined);
    vi.stubEnv('CLAUDE_PROJECT_DIR', fallback);
    settings.lastConceptionPath = fallback;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    settings.lastConceptionPath = '';
    await fs.rm(root, { recursive: true, force: true });
  });
  async function tree(name: string, config = '.condash/settings.json') {
    const path = join(root, name);
    await fs.mkdir(join(path, 'projects'), { recursive: true });
    const configPath = join(path, config);
    await fs.mkdir(join(configPath, '..'), { recursive: true });
    await fs.writeFile(configPath, '{}');
    return path;
  }
  async function refuses(flag: string | undefined, source: string) {
    await expect(resolveConception(flag)).rejects.toMatchObject({
      exitCode: 5,
      details: { triedSources: [`${source} (no recognised config file)`] },
    });
  }
  it('refuses an invalid flag despite every valid lower source', async () => {
    vi.stubEnv('CONDASH_CONCEPTION_PATH', fallback);
    await refuses(join(root, 'missing'), `--conception ${join(root, 'missing')}`);
  });
  it.each(['CONDASH_CONCEPTION_PATH', 'CONDASH_CONCEPTION'])('refuses invalid %s', async (name) => {
    const invalid = join(root, 'missing');
    vi.stubEnv(name, invalid);
    if (name === 'CONDASH_CONCEPTION_PATH') vi.stubEnv('CONDASH_CONCEPTION', fallback);
    await refuses(undefined, `$${name}=${invalid}`);
  });
  it('lets a valid flag win over invalid environment variables', async () => {
    vi.stubEnv('CONDASH_CONCEPTION_PATH', join(root, 'missing'));
    vi.stubEnv('CONDASH_CONCEPTION', join(root, 'also-missing'));
    expect(await resolveConception(fallback)).toEqual({ path: fallback, source: 'flag' });
  });
  it('prefers canonical environment over legacy', async () => {
    vi.stubEnv('CONDASH_CONCEPTION_PATH', fallback);
    vi.stubEnv('CONDASH_CONCEPTION', join(root, 'missing'));
    expect(await resolveConception(undefined)).toEqual({ path: fallback, source: 'env' });
  });
  it.each(['.condash/settings.json', 'condash.json', 'configuration.json'])(
    'accepts relative paths with %s',
    async (config) => {
      await tree('selected', config);
      expect(await resolveConception('../selected')).toEqual({
        path: join(root, 'selected'),
        source: 'flag',
      });
    },
  );
  it('refuses files, missing config, and missing projects', async () => {
    const file = join(root, 'file');
    await fs.writeFile(file, '{}');
    const noConfig = join(root, 'no-config');
    await fs.mkdir(join(noConfig, 'projects'), { recursive: true });
    const noProjects = await tree('no-projects');
    await fs.rm(join(noProjects, 'projects'), { recursive: true });
    for (const path of [file, noConfig, noProjects]) await refuses(path, `--conception ${path}`);
  });
  it('keeps advisory skill, cwd walk, and settings fallback', async () => {
    expect((await resolveConception(undefined)).source).toBe('CLAUDE_PROJECT_DIR');
    vi.stubEnv('CLAUDE_PROJECT_DIR', join(root, 'missing'));
    const nested = join(fallback, 'projects');
    vi.mocked(process.cwd).mockReturnValue(nested);
    expect(await resolveConception(undefined)).toEqual({ path: fallback, source: 'cwd-walk' });
    vi.mocked(process.cwd).mockReturnValue(root);
    expect(await resolveConception(undefined)).toEqual({ path: fallback, source: 'settings' });
  });
  it('preserves empty canonical environment treatment without selecting legacy', async () => {
    vi.stubEnv('CONDASH_CONCEPTION_PATH', '');
    vi.stubEnv('CONDASH_CONCEPTION', join(root, 'missing'));
    expect((await resolveConception(undefined)).source).toBe('CLAUDE_PROJECT_DIR');
  });
});
