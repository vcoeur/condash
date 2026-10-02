import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Subprocesses never inherit the user's root selectors.
const binary = resolve('dist-cli/condash.cjs');
let root: string;
let fallback: string;
let invalid: string;
let env: NodeJS.ProcessEnv;
beforeAll(async () => {
  const build = spawnSync(process.execPath, ['scripts/build-cli.mjs'], { encoding: 'utf8' });
  expect(build.status, build.stderr).toBe(0);
  root = await fs.mkdtemp(join(tmpdir(), 'condash-cli-path-'));
  fallback = join(root, 'fallback');
  invalid = join(root, 'invalid');
  await fs.mkdir(join(fallback, '.condash'), { recursive: true });
  await fs.mkdir(join(fallback, 'projects'), { recursive: true });
  await fs.mkdir(invalid);
  await fs.mkdir(join(root, 'xdg', 'condash'), { recursive: true });
  await fs.writeFile(join(fallback, '.condash', 'settings.json'), '{}');
  await fs.writeFile(join(fallback, 'projects', 'index.md'), 'Untouched fallback bytes\n');
  await fs.writeFile(
    join(root, 'xdg', 'condash', 'settings.json'),
    JSON.stringify({ lastConceptionPath: fallback }),
  );
  env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    CONDASH_CONCEPTION_PATH: '',
    CONDASH_CONCEPTION: '',
    CLAUDE_PROJECT_DIR: fallback,
  };
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [binary, ...args], {
    cwd: fallback,
    env: { ...env, ...overrides },
    encoding: 'utf8',
  });
}
async function snapshot(path: string): Promise<unknown> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => [
        entry.name,
        entry.isDirectory()
          ? await snapshot(join(path, entry.name))
          : (await fs.readFile(join(path, entry.name))).toString('base64'),
      ]),
  );
}
it('rejects read and write commands without changing any fallback bytes', async () => {
  const before = await snapshot(fallback);
  for (const args of [
    ['projects', 'list', '--conception', invalid],
    ['projects', 'index', '--conception', invalid, '--json'],
  ]) {
    const result = run(args, { CONDASH_CONCEPTION_PATH: fallback });
    expect(result.status).toBe(5);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(invalid);
    expect(result.stderr).toContain('no recognised config file');
    if (args.includes('--json')) expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    expect(await snapshot(fallback)).toEqual(before);
  }
});
it.each(['CONDASH_CONCEPTION_PATH', 'CONDASH_CONCEPTION'])(
  'rejects invalid %s at runtime',
  (name) => {
    const result = run(['projects', 'list', '--json'], {
      [name]: invalid,
      ...(name === 'CONDASH_CONCEPTION' ? { CONDASH_CONCEPTION_PATH: undefined } : {}),
    });
    expect(result.status).toBe(5);
    expect(result.stderr).toContain(`$${name}=${invalid}`);
    expect(result.stdout).toBe('');
  },
);
it('preserves valid flag precedence and empty flag usage errors', () => {
  expect(
    run(['projects', 'list', '--conception', fallback, '--json'], {
      CONDASH_CONCEPTION_PATH: invalid,
    }).status,
  ).toBe(0);
  expect(run(['projects', 'list', '--conception', '']).status).toBe(2);
});
it('keeps help, version, init and conception-path exemptions', () => {
  for (const args of [
    ['--help'],
    ['--version'],
    ['init', '--help'],
    ['config', 'conception-path', '--help'],
  ]) {
    expect(run(args, { CONDASH_CONCEPTION_PATH: invalid }).status).toBe(0);
  }
});
