import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootApp } from './fixtures/electron-app';

const execFileAsync = promisify(execFile);

const repositories = [
  {
    name: 'helio',
    submodules: [{ name: 'crates/parser' }, { name: 'crates/search' }],
  },
  'helio-web',
  'helio-docs',
];

const sameBasenameRepositories = [
  { path: 'a/docs', handle: 'alpha-docs', submodules: ['one'] },
  { path: 'b/docs', handle: 'beta-docs', submodules: ['two'] },
];

/** Create two real Git repositories with the same basename and direct children. */
async function prepareSameBasenameRepositories(conceptionDir: string): Promise<void> {
  const workspacePath = join(conceptionDir, 'workspace');
  for (const [parent, child] of [
    ['a/docs', 'one'],
    ['b/docs', 'two'],
  ]) {
    const parentPath = join(workspacePath, parent);
    await mkdir(join(parentPath, child), { recursive: true });
    await writeFile(join(parentPath, 'README.md'), '# docs\n', 'utf8');
    await writeFile(join(parentPath, child, 'README.md'), `# ${child}\n`, 'utf8');
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: parentPath });
    await execFileAsync('git', ['config', 'user.email', 'fixture@example.test'], {
      cwd: parentPath,
    });
    await execFileAsync('git', ['config', 'user.name', 'fixture'], { cwd: parentPath });
    await execFileAsync('git', ['add', '-A'], { cwd: parentPath });
    await execFileAsync('git', ['commit', '-m', 'Fixture'], { cwd: parentPath });
  }
  await writeFile(
    join(conceptionDir, '.condash', 'settings.json'),
    JSON.stringify({ workspace_path: workspacePath, repositories: sameBasenameRepositories }) +
      '\n',
    'utf8',
  );
}

test('Code pane reveals configured submodules only through their parent disclosure', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const booted = await bootApp({
    extraConfig: { workspace_path: '/nonexistent/workspace', repositories },
  });
  try {
    const pane = booted.window.locator('.repos-pane');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.repo-row')).toHaveCount(3);

    const disclosure = pane.locator('.repo-submodules-toggle');
    await expect(disclosure).toHaveAccessibleName('Show 2 submodules for #helio');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(pane.locator('.repo-submodules')).toHaveCount(1);
    await expect(pane.locator('.repo-submodules')).toBeHidden();
    await pane.screenshot({ path: testInfo.outputPath('code-family-collapsed.png') });

    await disclosure.click();
    await expect(disclosure).toHaveAccessibleName('Hide 2 submodules for #helio');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const children = pane.locator('.repo-submodules .repo-row');
    await expect(children).toHaveCount(2);
    await expect(children.locator('.repo-name')).toHaveText(['#parser', '#search']);
    await expect(children.locator('.repo-kind-tag')).toHaveText(['submodule', 'submodule']);
    await pane.screenshot({ path: testInfo.outputPath('code-family-expanded.png') });

    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(pane.locator('.repo-submodules')).toBeHidden();
    await expect(pane.locator('.repo-submodules .repo-row')).toHaveCount(0);
    await expect(pane.locator('.repo-row')).toHaveCount(3);
  } finally {
    await booted.cleanup();
  }
});

test('Code pane keeps same-basename families and disclosures independent', async () => {
  test.setTimeout(60_000);
  const booted = await bootApp({
    prepare: prepareSameBasenameRepositories,
  });
  try {
    const pane = booted.window.locator('.repos-pane');
    const alphaFamily = pane.locator('[data-repo-family$="/workspace/a/docs"]');
    const betaFamily = pane.locator('[data-repo-family$="/workspace/b/docs"]');
    const alphaDisclosure = alphaFamily.locator('.repo-submodules-toggle');
    const betaDisclosure = betaFamily.locator('.repo-submodules-toggle');

    await expect(alphaFamily).toBeVisible();
    await expect(betaFamily).toBeVisible();
    await expect(alphaDisclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(betaDisclosure).toHaveAttribute('aria-expanded', 'false');
    const alphaControls = await alphaDisclosure.getAttribute('aria-controls');
    const betaControls = await betaDisclosure.getAttribute('aria-controls');
    expect(alphaControls).not.toBe(betaControls);

    await alphaDisclosure.click();
    await expect(alphaDisclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(betaDisclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(alphaFamily.locator(`[id="${alphaControls}"]`)).toHaveCount(1);
    await expect(alphaFamily.locator('.repo-submodules .repo-name')).toHaveText(['#one']);
    await expect(betaFamily.locator('.repo-submodules')).toBeHidden();
    await expect(betaFamily.locator('.repo-submodules .repo-row')).toHaveCount(0);

    await betaDisclosure.click();
    await expect(betaDisclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(betaFamily.locator('.repo-submodules .repo-name')).toHaveText(['#two']);

    await alphaDisclosure.click();
    await expect(alphaFamily.locator('.repo-submodules')).toBeHidden();
    await expect(betaFamily.locator('.repo-submodules .repo-name')).toHaveText(['#two']);
  } finally {
    await booted.cleanup();
  }
});
