import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const builderRequire = createRequire(join(root, 'node_modules/electron-builder/package.json'));
const { createUpdateInfoTasks, writeUpdateInfoFiles } = builderRequire(
  'app-builder-lib/out/publish/updateInfoBuilder.js',
);
const { Platform } = builderRequire('app-builder-lib/out/core.js');
const { Arch } = builderRequire('builder-util');
const { computeSafeArtifactNameIfNeeded, PlatformPackager } = builderRequire(
  'app-builder-lib/out/platformPackager.js',
);
const script = join(root, 'scripts/finalize-update-manifests.mjs');
const image = 'condash-1.2.3.AppImage';
const deb = 'condash_1.2.3_amd64.deb';
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'condash-packaging-'));
});

async function generate(platform: typeof Platform.LINUX, names: string[], arch = Arch.x64) {
  const packager = {
    platform,
    platformSpecificBuildOptions: {},
    config: {},
    appInfo: { version: '1.2.3' },
    info: { metadata: { dependencies: { 'electron-updater': '6.6.0' } } },
    getResource: async () => null,
    dispatchArtifactCreated: () => {},
  };
  const tasks = [];
  for (const name of names) {
    const file = join(directory, name);
    await writeFile(file, `fixture ${name}\n`);
    tasks.push(
      ...(await createUpdateInfoTasks(
        {
          file,
          packager,
          arch,
          target: { outDir: directory },
          updateInfo: {
            size: (await stat(file)).size,
            sha512: createHash('sha512')
              .update(await readFile(file))
              .digest('base64'),
          },
          safeArtifactName: computeSafeArtifactNameIfNeeded(name, () => 'unexpected-fallback.exe'),
        },
        [{ provider: 'github' }],
      )),
    );
  }
  await writeUpdateInfoFiles(tasks, packager);
}

function run(checkOnly = false) {
  return spawnSync(process.execPath, [script, directory, ...(checkOnly ? ['--check'] : [])], {
    encoding: 'utf8',
  });
}

async function metadata(name = 'latest-linux.yml') {
  return parse(await readFile(join(directory, name), 'utf8'));
}

async function mutate(
  change: (value: ReturnType<typeof parse>) => void,
  name = 'latest-linux.yml',
) {
  const value = await metadata(name);
  change(value);
  await writeFile(join(directory, name), stringify(value));
}

describe('final installer manifest CLI', () => {
  it('keeps unchanged builder-generated Linux, Windows and multiarch mac manifests byte-identical', async () => {
    await generate(Platform.LINUX, [image, deb]);
    await generate(Platform.WINDOWS, ['condash.Setup.1.2.3.exe']);
    await generate(Platform.MAC, ['condash-1.2.3-x64.dmg', 'condash-1.2.3-arm64.dmg']);
    const names = ['latest-linux.yml', 'latest.yml', 'latest-mac.yml'];
    const before = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified 3 manifests and 5 artifacts; refreshed 0');
    expect(await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')))).toEqual(
      before,
    );
  });

  it('refreshes only repacked AppImage entries and all repeated legacy fields, then is idempotent', async () => {
    await generate(Platform.LINUX, [image, deb]);
    await mutate((value) => {
      value.size = value.files[0].size;
      value.releaseNotes = 'preserve me';
    });
    const before = await metadata();
    const bytes = Buffer.from('repacked final image bytes\n');
    await writeFile(join(directory, image), bytes);
    expect(run(true).status).toBe(1);
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const after = await metadata();
    const sha512 = createHash('sha512').update(bytes).digest('base64');
    expect(after.files[0]).toEqual({ ...before.files[0], size: bytes.length, sha512 });
    expect(after.files[1]).toEqual(before.files[1]);
    expect(after.path).toBe(image);
    expect(after.sha512).toBe(sha512);
    expect(after.size).toBe(bytes.length);
    expect(after.releaseNotes).toBe('preserve me');
    expect(after.releaseDate).toBe(before.releaseDate);
    const finalized = await readFile(join(directory, 'latest-linux.yml'), 'utf8');
    expect(run(true).status).toBe(0);
    expect(run().stdout).toContain('refreshed 0');
    expect(await readFile(join(directory, 'latest-linux.yml'), 'utf8')).toBe(finalized);
  });

  it('handles architecture-specific Linux manifests independently', async () => {
    await generate(Platform.LINUX, [image]);
    const armImage = 'condash-1.2.3-arm64.AppImage';
    await generate(Platform.LINUX, [armImage], Arch.arm64);
    await writeFile(join(directory, image), 'final x64');
    await writeFile(join(directory, armImage), 'different final arm64');
    expect(run().status).toBe(0);
    expect((await metadata()).path).toBe(image);
    expect((await metadata('latest-linux-arm64.yml')).path).toBe(armImage);
    expect(run(true).status).toBe(0);
  });

  it.each(['size', 'sha512'] as const)(
    'rejects a bad non-AppImage %s without writing pending Linux repairs',
    async (field) => {
      await generate(Platform.LINUX, [image, deb]);
      await writeFile(join(directory, image), 'final image');
      await mutate((value) => {
        value.files[1][field] = field === 'size' ? 0 : 'bad';
      });
      const before = await readFile(join(directory, 'latest-linux.yml'), 'utf8');
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(field === 'size' ? 'size mismatch' : 'SHA-512 mismatch');
      expect(await readFile(join(directory, 'latest-linux.yml'), 'utf8')).toBe(before);
    },
  );

  it.each(['size', 'sha512'] as const)(
    'rejects stale Linux %s in read-only mode',
    async (field) => {
      await generate(Platform.LINUX, [image]);
      await mutate((value) => {
        value.files[0][field] = field === 'size' ? -1 : 'bad';
      });
      expect(run(true).status).toBe(1);
    },
  );

  it.each(['latest.yml', 'latest-mac.yml'])(
    'rejects a later broken %s before writing any Linux repair',
    async (name) => {
      await generate(Platform.LINUX, [image]);
      await generate(name === 'latest.yml' ? Platform.WINDOWS : Platform.MAC, [
        name === 'latest.yml' ? 'condash.Setup.1.2.3.exe' : 'condash-1.2.3-arm64.dmg',
      ]);
      await writeFile(join(directory, image), 'repacked');
      await mutate((value) => {
        value.sha512 = 'wrong legacy hash';
      }, name);
      const before = await readFile(join(directory, 'latest-linux.yml'), 'utf8');
      expect(run().status).toBe(1);
      expect(await readFile(join(directory, 'latest-linux.yml'), 'utf8')).toBe(before);
    },
  );

  it.each(['missing.AppImage', 'Condash-1.2.3.AppImage', 'condash-Setup-1.2.3.exe'])(
    'fails closed on missing/wrong exact filename %s',
    async (name) => {
      await generate(Platform.LINUX, [image]);
      await mutate((value) => {
        value.files[0].url = value.path = name;
      });
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Missing artifact: ${name}`);
    },
  );

  it.each([
    '../escape.AppImage',
    '/escape.AppImage',
    'C:\\escape.exe',
    'nested/file.dmg',
    'nested\\file.exe',
    'https://example.invalid/file.exe',
    '%2e%2e.AppImage',
    'file.exe?query',
    'file.exe#fragment',
    'file\n.exe',
    'not-uploaded.zip',
  ])('rejects unsafe/unuploaded reference %j', async (name) => {
    await generate(Platform.LINUX, [image]);
    await mutate((value) => {
      value.files[0].url = value.path = name;
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsafe or unuploaded artifact name');
  });

  it('rejects a legacy path not represented in files even when that artifact exists', async () => {
    await generate(Platform.LINUX, [image, deb]);
    await writeFile(join(directory, 'other.AppImage'), 'other');
    await mutate((value) => {
      value.path = 'other.AppImage';
    });
    expect(run().stderr).toContain('path must reference a files entry');
  });

  it.each(['size', 'sha512'] as const)(
    'validates every macOS architecture entry %s without repairing it',
    async (field) => {
      await generate(Platform.MAC, ['condash-1.2.3-x64.dmg', 'condash-1.2.3-arm64.dmg']);
      await mutate((value) => {
        value.files[1][field] = field === 'size' ? 'wrong type' : 'bad';
      }, 'latest-mac.yml');
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('condash-1.2.3-arm64.dmg');
      expect(result.stderr).toContain(field === 'size' ? 'size mismatch' : 'SHA-512 mismatch');
    },
  );

  it('rejects artifact symlinks and directories', async () => {
    await generate(Platform.LINUX, [image]);
    await symlink(join(directory, image), join(directory, 'link.AppImage'));
    await mutate((value) => {
      value.files[0].url = value.path = 'link.AppImage';
    });
    expect(run().stderr).toContain('not a regular file');
    await mkdir(join(directory, 'folder.AppImage'));
    await mutate((value) => {
      value.files[0].url = value.path = 'folder.AppImage';
    });
    expect(run().stderr).toContain('not a regular file');
  });

  it('rejects symlink manifests rather than rewriting their targets', async () => {
    await generate(Platform.LINUX, [image]);
    await symlink(join(directory, 'latest-linux.yml'), join(directory, 'latest-linked.yml'));
    expect(run().stderr).toContain('Manifest is not a regular file');
  });

  it.each([
    'files: [',
    'files: []',
    'files: null',
    'files: [null]',
    'files: [{url: file.exe}]',
    'files: []\nfiles: []',
  ])('rejects malformed metadata %j', async (text) => {
    await writeFile(join(directory, 'latest.yml'), text);
    expect(run().status).toBe(1);
  });

  it('rejects an empty directory and invalid CLI arguments', () => {
    expect(run().stderr).toContain('No latest*.yml');
    const result = spawnSync(process.execPath, [script, directory, '--unknown'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('packaging configuration wiring', () => {
  it('places exactly one unconditional validation after repacking and immediately before upload', async () => {
    const workflow = parse(await readFile(join(root, '.github/workflows/_build.yml'), 'utf8'));
    const steps = workflow.jobs.build.steps;
    const matches = steps.filter((step: { run?: string }) =>
      step.run?.includes('finalize-update-manifests.mjs'),
    );
    expect(matches).toHaveLength(1);
    const index = steps.indexOf(matches[0]);
    expect(steps[index - 1].name).toBe('Inject --no-sandbox into AppImage AppRun');
    expect(steps[index + 1].uses).toBe('actions/upload-artifact@v6');
    expect(matches[0].if).toBeUndefined();
    expect(matches[0].run).toBe('node scripts/finalize-update-manifests.mjs release');
  });

  it('expands NSIS output through builder naming and emits that exact GitHub metadata target', async () => {
    const config = parse(await readFile(join(root, 'electron-builder.yml'), 'utf8'));
    expect(config.nsis.artifactName).toBe('${productName}.Setup.${version}.${ext}');
    const fakePackager = {
      appInfo: { sanitizedProductName: 'condash', name: 'condash', version: '1.2.3' },
      platform: Platform.WINDOWS,
      platformSpecificBuildOptions: {},
      config,
      artifactPatternConfig: PlatformPackager.prototype.artifactPatternConfig,
      computeArtifactName: PlatformPackager.prototype.computeArtifactName,
      expandMacro: PlatformPackager.prototype.expandMacro,
    };
    const name = PlatformPackager.prototype.expandArtifactNamePattern.call(
      fakePackager,
      config.nsis,
      'exe',
      Arch.x64,
    );
    expect(name).toBe('condash.Setup.1.2.3.exe');
    expect(computeSafeArtifactNameIfNeeded(name, () => 'fallback.exe')).toBeNull();
    await generate(Platform.WINDOWS, [name]);
    const manifest = await metadata('latest.yml');
    expect(manifest.path).toBe(name);
    expect(manifest.files[0].url).toBe(name);
    expect(run().status).toBe(0);
  });
});
