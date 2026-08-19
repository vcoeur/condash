/**
 * Screenshot harness.
 *
 * Drives the packaged Electron build against the bundled `tests/fixtures/conception-demo`
 * and captures the 17 PNG slugs (× 2 themes = 34 files) that the public docs site references.
 *
 * Run as `npm run test -- --reporter=list screenshots.spec.ts`. Output lands in
 * `tests/screenshots-out/{light,dark}/<name>.png` — with NO theme suffix, one
 * directory per theme. Landing them in `docs/assets/screenshots/` therefore
 * needs a rename, not a plain `cp` (a bare
 * `cp tests/screenshots-out/{light,dark}/*.png docs/assets/screenshots/` writes
 * unsuffixed names and lets the dark pass clobber the light one), plus a
 * halving back to the 1600×1100 the docs ship:
 *
 *   for theme in light dark; do
 *     for f in tests/screenshots-out/$theme/*.png; do
 *       convert "$f" -resize 50% -strip \
 *         "docs/assets/screenshots/$(basename "$f" .png)-$theme.png"
 *     done
 *   done
 *   pngquant --force --skip-if-larger --quality=70-95 --ext .png \
 *     docs/assets/screenshots/*.png
 *
 * (ImageMagick and pngquant are local docs-authoring tools only — the harness
 * itself has no such dependency, so the tag-time CI run stays clean. Without
 * them, `cp` the 2× files instead and accept ~14 MB of assets. The palette pass
 * is what keeps the whole directory at ~2.7 MB.)
 *
 * The window is composed at 1600×1100 logical px and captured at
 * `deviceScaleFactor: 2`, so the raw PNGs are 3200×2200. BOTH halves of that are
 * load-bearing and neither works alone: Electron's `--force-device-scale-factor`
 * makes the compositor surface 2×, and the CDP device-metrics override makes the
 * page agree (`devicePixelRatio === 2`) so Playwright captures those real pixels.
 * With only the Electron flag — the pre-2026-07 setup — `page.setViewportSize`
 * pinned the page to dpr 1, the capture came out 1600×1100, and xterm rendered
 * its glyphs at HALF size: every committed `terminal-*.png` had a ~6px, unreadable
 * body. Halving the 2× capture on the way into docs/ keeps the display serif's
 * hinting intact too (at a straight 1× capture the crossbar drops out of every `e`).
 *
 * Everything the run writes lives under one stable, human-looking demo root
 * (`<tmpdir>/condash-demo`) rather than a `mkdtemp` suffix: several surfaces
 * (deliverable rows, the Settings modal) render absolute paths into the
 * published PNGs, and a random `condash-shots-conception-TWYcoA` in a docs
 * screenshot is noise. The root is wiped before and after each boot.
 */

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

declare global {
  interface Window {
    /** Test-only xterm registry, populated by `src/renderer/xterm-mount.ts` when
     *  `<body data-test-xterm-registry>` is set. Typed structurally to the two
     *  members this spec reads so no xterm types leak into the test project. */
    __condashXterms?: Map<
      string,
      {
        buffer: {
          active: {
            length: number;
            getLine(index: number): { translateToString(): string } | undefined;
          };
        };
      }
    >;
  }
}

const repoRoot = resolve(__dirname, '..');
const fixtureSrc = resolve(__dirname, 'fixtures', 'conception-demo');
const outRoot = resolve(__dirname, 'screenshots-out');

/** Everything one capture run writes. Stable (not `mkdtemp`) so no random
 *  suffix reaches a published PNG; wiped before every boot. */
const demoRoot = join(tmpdir(), 'condash-demo');
const conceptionDir = join(demoRoot, 'conception');
const userDataDir = join(demoRoot, 'userdata');
const demoBinDir = join(demoRoot, 'bin');
/** Where the seeded git repos live. Derived from `demoRoot`, and written INTO
 *  the copied fixture config at boot rather than read out of it: the fixture
 *  ships POSIX literals under `/tmp`, so on a host with `TMPDIR ≠ /tmp` the
 *  seeded repos would sit outside the tree `rm(demoRoot)` wipes. The light run
 *  would then strand them, and the dark run's `seedWorkspace()` would restore
 *  README.md to its clean content, stage nothing, and reject out of `boot()` on
 *  a `git commit` with an empty index. Deriving both paths here keeps the seed
 *  target and the cleanup target the same by construction. */
const workspacePath = join(demoRoot, 'workspace');
const worktreesPath = join(demoRoot, 'worktrees');

/** Logical (CSS-pixel) window the shots are composed against, and the scale the
 *  capture runs at. Every PNG lands at `width*scale × height*scale`. */
const VIEWPORT = { width: 1600, height: 1100 };
const DEVICE_SCALE = 2;

type Theme = 'light' | 'dark';

/**
 * The personal / per-machine half of the demo. These keys are global-owned
 * (`GLOBAL_ONLY_KEYS` in `src/main/config-scope.ts`), so they cannot live in
 * the fixture's `.condash/settings.json` — a conception tree never describes
 * an agent list or a shell. Seeded straight into the throwaway XDG
 * `settings.json` instead, which is where a real install keeps them.
 */
const demoGlobalSettings = {
  agents: [
    { id: 'claude', label: 'Claude', command: 'claude', promptFlags: true, favorite: true },
    {
      id: 'claude-kimi',
      label: 'Claude · Kimi',
      command: 'claude-kimi',
      promptFlags: true,
      favorite: true,
    },
    { id: 'opencode-kimi', label: 'OpenCode · Kimi', command: 'opencode-kimi', promptFlags: true },
    { id: 'aider-kimi', label: 'Aider · Kimi', command: 'aider-kimi' },
  ],
  open_with: {
    main_ide: { label: 'Open in main IDE', command: 'idea {path}' },
    secondary_ide: { label: 'Open in secondary IDE', command: 'code {path}' },
    terminal: { label: 'Open terminal here', command: 'ghostty --working-directory={path}' },
  },
  pdf_viewer: ['xdg-open {path}'],
  terminal: {
    shell: join(demoBinDir, 'demo-shell'),
    shortcut: 'Ctrl+`',
    screenshot_dir: join(demoRoot, 'screenshots'),
    screenshot_paste_shortcut: 'Ctrl+Shift+V',
    move_tab_left_shortcut: 'Ctrl+Left',
    move_tab_right_shortcut: 'Ctrl+Right',
  },
  // The tree panes ship fully collapsed on a fresh profile (`tree-expansion.ts`),
  // which makes Knowledge / Resources / Skills screenshot as three header rows.
  // Seed the directories that should be open; the values are tree-root-relative
  // posix paths, exactly what `toggleTreeExpand` persists.
  treeExpansion: {
    knowledge: ['internal', 'topics', 'topics/ops'],
    resources: ['notes'],
    skills: ['example-skill', 'release-helio'],
  },
};

/** Every slug the sweep must produce, with the floor its PNG must clear.
 *  The floors are ~half the observed byte size — small enough not to be
 *  brittle, large enough to catch the failure this list exists for: a blank
 *  or sliver capture (the committed `projects-done` pair was 1.7 kB). */
const EXPECTED_SHOTS: { slug: string; minBytes: number }[] = [
  { slug: 'dashboard-overview', minBytes: 150_000 },
  { slug: 'activity-rail', minBytes: 5_000 },
  { slug: 'projects-done', minBytes: 25_000 },
  { slug: 'code-pane', minBytes: 80_000 },
  { slug: 'code-pane-dirty', minBytes: 80_000 },
  { slug: 'knowledge-pane', minBytes: 150_000 },
  { slug: 'terminal', minBytes: 150_000 },
  { slug: 'spawn-dropdown', minBytes: 150_000 },
  { slug: 'item-fuzzy-search', minBytes: 150_000 },
  { slug: 'item-document-with-pdf', minBytes: 150_000 },
  { slug: 'status-unknown-badge', minBytes: 150_000 },
  { slug: 'resources-pane', minBytes: 150_000 },
  { slug: 'skills-pane', minBytes: 150_000 },
  { slug: 'tasks-pane', minBytes: 100_000 },
  { slug: 'deliverables-pane', minBytes: 150_000 },
  { slug: 'plan-document', minBytes: 150_000 },
  { slug: 'settings-modal', minBytes: 150_000 },
];

/** Slugs captured as an element clip rather than the whole window — exempt from
 *  the full-window dimension assertion below. */
const CLIPPED_SHOTS = new Set(['activity-rail', 'projects-done']);

/** Width/height straight out of a PNG's IHDR chunk (bytes 16..24). Avoids
 *  pulling an image library in for two integers. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

interface Booted {
  app: ElectronApplication;
  page: Page;
}

/** `git` in a throwaway repo: no global identity is assumed (CI has none), and
 *  the initial branch is pinned so the repo cards read `main`, not whatever the
 *  host's `init.defaultBranch` happens to be. */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

/**
 * Create the throwaway repos the fixture's `repositories` list names, so the
 * Code pane renders real branch names and a real dirty count instead of
 * `(no branch)` on every card — the "helio with a dirty-file indicator"
 * the docs promise.
 */
async function seedWorkspace(workspacePath: string): Promise<void> {
  const repos = [
    { name: 'helio', extra: ['crates/parser/lib.rs', 'crates/search/lib.rs'] },
    { name: 'helio-web', extra: [] as string[] },
    { name: 'helio-docs', extra: [] as string[] },
  ];
  for (const repo of repos) {
    const dir = join(workspacePath, repo.name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.md'), `# ${repo.name}\n\nDemo repository.\n`, 'utf8');
    for (const relative of repo.extra) {
      const file = join(dir, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, '// demo\n', 'utf8');
    }
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.email', 'demo@example.org');
    await git(dir, 'config', 'user.name', 'helio demo');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'Initial import');
  }
  // One uncommitted edit in `helio` so its card carries the dirty pill.
  await writeFile(
    join(workspacePath, 'helio', 'README.md'),
    '# helio\n\nDemo repository.\n\nWIP: sliding mmap window for postings.bin.\n',
    'utf8',
  );
}

/**
 * A shell whose prompt and PATH are ours: the default bash prompt carries
 * `user@host:cwd`, which has no business in a published screenshot, and the
 * demo needs a `helio` on PATH so the terminal shot can run the command its
 * caption claims. `spawnPtyEnv()` replaces PATH with the resolved login-shell
 * PATH, so prepending here (inside the shell) is the only place that survives.
 */
async function seedDemoShell(): Promise<void> {
  await mkdir(demoBinDir, { recursive: true });
  const shell = join(demoBinDir, 'demo-shell');
  await writeFile(
    shell,
    [
      '#!/bin/sh',
      `PATH="${demoBinDir}:$PATH"`,
      'export PATH',
      "PS1='helio-demo:~$ '",
      'export PS1',
      'exec /bin/bash --norc --noprofile -i',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  await writeFile(
    join(demoBinDir, 'helio'),
    [
      '#!/bin/sh',
      "echo 'trigram index: 1,284,301 postings over 3 files (mmap window 64 MB)'",
      "echo '2026-04-15T09:12:03  access.log.3   503 GET  /api/reports/4981   11.4 ms'",
      "echo '2026-04-15T09:12:04  access.log.3   502 GET  /api/sync            9.8 ms'",
      "echo '2026-04-15T09:12:07  access.log.2   500 POST /api/import         14.2 ms'",
      "echo '3 hits · first hit 0.14 s · scanned 0 bytes (index hit)'",
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
}

async function boot(theme: Theme): Promise<Booted> {
  await rm(demoRoot, { recursive: true, force: true });
  await cp(fixtureSrc, conceptionDir, { recursive: true });

  // Rewrite the two path keys in the copied config from `demoRoot`, so what the
  // Code pane reads, what `seedWorkspace()` writes, and what `shutdown()` wipes
  // are the same directory on every host. The fixture's own literals are only a
  // readable default for someone opening the tree by hand.
  const conceptionConfigPath = join(conceptionDir, '.condash', 'settings.json');
  const conceptionConfig = JSON.parse(await readFile(conceptionConfigPath, 'utf8')) as Record<
    string,
    unknown
  >;
  conceptionConfig.workspace_path = workspacePath;
  conceptionConfig.worktrees_path = worktreesPath;
  await writeFile(conceptionConfigPath, JSON.stringify(conceptionConfig, null, 2) + '\n', 'utf8');
  await seedWorkspace(workspacePath);
  await seedDemoShell();

  await mkdir(join(userDataDir, 'condash'), { recursive: true });
  // Layout: projects + code visible at 50/50 (798px each + 4px splitter on
  // the 1600px viewport) so the documentation screenshots show both panes
  // with comparable weight. Terminal off by default — individual shots
  // toggle it on as needed.
  await writeFile(
    join(userDataDir, 'condash', 'settings.json'),
    JSON.stringify(
      {
        lastConceptionPath: conceptionDir,
        recentConceptionPaths: [conceptionDir],
        theme,
        layout: {
          projects: true,
          leftView: 'projects',
          working: 'code',
          terminal: false,
          projectsSplit: 0.5,
        },
        ...demoGlobalSettings,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const app = await electron.launch({
    args: ['.', '--no-sandbox', `--force-device-scale-factor=${DEVICE_SCALE}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: userDataDir,
      CONDASH_FORCE_PROD: '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Emulate the viewport rather than resizing the window: the Xvfb display is
  // smaller than the shot, so a real 1600×1100 window would be clamped.
  // `deviceScaleFactor: 2` is what makes the capture 3200×2200 — plain
  // `page.setViewportSize` pins it to 1, and the resulting 1× glyph hinting
  // drops the crossbar out of every `e` in the display serif.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: DEVICE_SCALE,
    mobile: false,
  });
  // Collapse animations/transitions (same trick as tests/fixtures/electron-app.ts):
  // under xvfb a transition mid-flight makes Playwright's actionability check
  // wait forever, and a half-faded modal makes a bad screenshot.
  await page
    .addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }`,
    })
    .catch(() => undefined);
  // Wait for the activity rail so we know the renderer mounted. The rail
  // is always rendered (it hosts the Projects item), so it's a stable
  // mount landmark independent of whether a conception path is loaded.
  await page.locator('.rail').first().waitFor({ state: 'visible', timeout: 15_000 });
  // Opt into the test-only xterm registry (`xterm-mount.ts`) before any terminal
  // mounts, so `readTerminalText()` can read the shell's output for the terminal
  // shot's pre-capture probe. Sets a bare data attribute on <body>; nothing about
  // the rendered pixels changes.
  await page.evaluate(() => document.body.setAttribute('data-test-xterm-registry', ''));
  // Wait for the persisted theme to hydrate rather than forcing the attribute —
  // that way the shot also proves the real boot path applied it.
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.theme === expected,
    theme,
    { timeout: 10_000 },
  );
  return { app, page };
}

async function shutdown(b: Booted): Promise<void> {
  await b.app.close().catch(() => undefined);
  await rm(demoRoot, { recursive: true, force: true });
}

async function settle(page: Page, ms = 250): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Park the pointer somewhere inert before a capture. Playwright leaves it
 *  wherever the last click landed, so without this every shot carries a stray
 *  hover highlight or a rail tooltip over the content it is meant to show. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10);
  await settle(page, 200);
}

/**
 * Assert, immediately before a capture, that the surface the shot exists to
 * show is mounted and carries real content.
 *
 * The file checks at the end of this test cannot see any of this. A full-window
 * PNG whose target pane is absent, blank, or showing an empty state still
 * clears its byte floor *and* its dimension check, because the surrounding
 * chrome (rail, header, project list, tab strip) is identical either way and
 * dominates the byte count. Every regression this harness was rebuilt to fix —
 * the hidden Code pane, the empty terminal body, the "No skills available"
 * Skills pane — passed those file checks and would pass them again. These
 * per-shot probes are the part that actually catches that class, so keep one at
 * every `shoot()` site.
 *
 * `root` must be visible with a non-degenerate box; `items` (when given) must
 * have at least `minItems` matches inside it; `text` (when given) must appear
 * in it.
 */
async function requireContent(
  page: Page,
  slug: string,
  spec: { root: string; items?: string; minItems?: number; text?: string | RegExp },
): Promise<void> {
  const root = page.locator(spec.root).first();
  await expect(root, `${slug}: ${spec.root} never became visible`).toBeVisible({ timeout: 10_000 });
  const box = await root.boundingBox();
  expect(box, `${slug}: ${spec.root} has no layout box`).not.toBeNull();
  expect(
    Math.min(box?.width ?? 0, box?.height ?? 0),
    `${slug}: ${spec.root} rendered ${box?.width}×${box?.height}`,
  ).toBeGreaterThan(40);
  if (spec.items) {
    const minItems = spec.minItems ?? 1;
    const found = await root.locator(spec.items).count();
    expect(
      found,
      `${slug}: ${spec.root} holds ${found} × ${spec.items}, expected at least ${minItems}`,
    ).toBeGreaterThanOrEqual(minItems);
  }
  if (spec.text) {
    await expect(root, `${slug}: ${spec.root} does not carry ${spec.text}`).toContainText(
      spec.text,
      { timeout: 10_000 },
    );
  }
}

/**
 * Plain text of every live xterm buffer, scrollback included.
 *
 * The terminal paints through the WebGL renderer, so its content is not in the
 * DOM at all and no selector can see it — `data-test-xterm-registry` (armed in
 * `boot()`, read here) is the only handle on it, and without it the "empty
 * terminal body" regression is invisible to every DOM assertion.
 */
async function readTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const registry = window.__condashXterms;
    if (!registry) return '';
    const lines: string[] = [];
    for (const term of registry.values()) {
      const buffer = term.buffer.active;
      for (let i = 0; i < buffer.length; i++) {
        lines.push(buffer.getLine(i)?.translateToString() ?? '');
      }
    }
    return lines.join('\n');
  });
}

async function shoot(page: Page, theme: Theme, name: string): Promise<void> {
  const dir = join(outRoot, theme);
  await mkdir(dir, { recursive: true });
  try {
    await page.screenshot({
      path: join(dir, `${name}.png`),
      fullPage: false,
      timeout: 8_000,
    });
  } catch (err) {
    // CodeMirror / heavy DOM occasionally stalls Playwright's screenshot pipe.
    // Don't let one bad shot abort the whole sweep — log and move on; the
    // per-slug assertion at the end of the test still fails the run.
    console.error(`[shoot] ${theme}/${name} failed: ${(err as Error).message}`);
  }
}

/** Screenshot a padded box around one element. */
async function shootClip(
  page: Page,
  theme: Theme,
  name: string,
  box: { x: number; y: number; width: number; height: number },
  pad = 16,
): Promise<void> {
  const dir = join(outRoot, theme);
  await mkdir(dir, { recursive: true });
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  try {
    await page.screenshot({
      path: join(dir, `${name}.png`),
      clip: {
        x,
        y,
        width: Math.min(box.width + pad * 2, VIEWPORT.width - x),
        height: Math.min(box.height + pad * 2, VIEWPORT.height - y),
      },
      timeout: 8_000,
    });
  } catch (err) {
    console.error(`[shoot-clip] ${theme}/${name}: ${(err as Error).message}`);
  }
}

/** Send a menu-command IPC to the renderer. The composite layout has no
 *  in-window tab strip — pane visibility is driven by the application menu
 *  ('toggle-projects', 'show-code', 'show-knowledge', 'hide-working',
 *  'open-settings', 'toggle-terminal', 'search'), so screenshot prep goes
 *  through the same channel a real menu click would. */
async function sendMenu(app: ElectronApplication, command: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, cmd) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.send('menu-command', cmd);
  }, command);
}

/** True when the rail item whose tooltip starts with `label` is the active one.
 *  `aria-pressed` is the renderer's own notion of "this surface is showing"
 *  (`activity-rail.tsx`), which is what makes every helper below idempotent. */
async function railPressed(page: Page, label: string): Promise<boolean> {
  const item = page.locator(`.rail-item[title^="${label}"]`).first();
  return (await item.getAttribute('aria-pressed')) === 'true';
}

/**
 * Fill the left band with one of its views.
 *
 * `toggleLeftView` hides the band when the requested view is already the
 * active one (`use-layout.ts`), so the `aria-pressed` guard is what keeps this
 * a "show", not a toggle.
 */
async function showLeftView(
  page: Page,
  label: 'Projects' | 'Tasks' | 'Deliverables',
): Promise<void> {
  if (!(await railPressed(page, label))) {
    await page.locator(`.rail-item[title^="${label}"]`).first().click();
  }
  await settle(page);
}

/**
 * Show one pane in the working-surface slot.
 *
 * `show-code` / `show-knowledge` / `show-resources` / `show-skills` are
 * **tristate toggles**, not idempotent "show" commands: each sets the slot to
 * `null` when its own surface is already there (`menu-commands.ts`). The boot
 * layout persists `working: 'code'`, so an unguarded `show-code` HID the
 * working surface and produced a blank right half — which is exactly what the
 * committed `code-pane-{light,dark}.png` used to show. Guard on `aria-pressed`.
 */
async function showWorking(
  b: Booted,
  label: 'Code' | 'Knowledge' | 'Resources' | 'Skills',
): Promise<void> {
  if (!(await railPressed(b.page, label))) {
    const command = {
      Code: 'show-code',
      Knowledge: 'show-knowledge',
      Resources: 'show-resources',
      Skills: 'show-skills',
    }[label];
    await sendMenu(b.app, command);
  }
  await settle(b.page, 400);
}

/** Show or hide the whole left band, whatever view it currently holds. */
async function setProjectsBand(b: Booted, visible: boolean): Promise<void> {
  const shown = await b.page.locator('.projects-pane, .tasks-pane, .deliverables-stack').count();
  if (shown > 0 !== visible) await sendMenu(b.app, 'toggle-projects');
  await settle(b.page, 400);
}

async function captureForTheme(theme: Theme): Promise<void> {
  const b = await boot(theme);
  const { page } = b;
  try {
    // 1. dashboard-overview — the composite landing view: Projects on the left,
    //    Code in the working slot.
    await showLeftView(page, 'Projects');
    await showWorking(b, 'Code');
    await settle(page, 600);
    await parkPointer(page);
    await requireContent(page, 'dashboard-overview', {
      root: '.projects-pane',
      items: '.row',
      minItems: 5,
    });
    await requireContent(page, 'dashboard-overview', {
      root: '.repos-pane',
      items: '.repo-row',
      minItems: 5,
    });
    await shoot(page, theme, 'dashboard-overview');

    // 2. activity-rail — a narrow clip of the rail itself. It is the app's
    //    primary navigation and the one element both shortcut pages need to
    //    show; a full-window shot renders it 52px wide and unreadable. Clipped
    //    to the icon block, not the rail's full 1100px height — the rest is
    //    empty and would render the strip unreadably thin in a docs column.
    {
      await requireContent(page, 'activity-rail', {
        root: '.rail',
        items: '.rail-item',
        minItems: 9,
      });
      const rail = await page.locator('.rail').first().boundingBox();
      const lastItem = await page.locator('.rail-item').last().boundingBox();
      if (rail && lastItem) {
        await shootClip(
          page,
          theme,
          'activity-rail',
          {
            x: rail.x,
            y: rail.y,
            width: rail.width,
            height: lastItem.y + lastItem.height - rail.y,
          },
          10,
        );
      }
    }

    // 3. projects-done — the Done status group. It is a collapsible subgroup
    //    (`.group-block.subgroup`, projects-parts/cards.tsx) that defaults to
    //    COLLAPSED, so clipping it without expanding first captured a 763×78
    //    sliver of a header row. Click the header, then clip the expanded block.
    {
      const section = page.locator('.group-block[data-status="done"]').first();
      if (await section.count()) {
        await section.scrollIntoViewIfNeeded();
        await settle(page);
        if (await section.evaluate((el) => el.classList.contains('collapsed'))) {
          await section.locator('.group-header').first().click();
          await settle(page, 400);
        }
        await section.scrollIntoViewIfNeeded();
        await settle(page, 400);
        await parkPointer(page);
        // The sliver failure was a collapsed block clipped to its header row:
        // 763×78 of chrome and no cards at all. Assert the cards are there.
        await requireContent(page, 'projects-done', {
          root: '.group-block[data-status="done"]',
          items: '.row',
          minItems: 2,
        });
        const box = await section.boundingBox();
        if (box) await shootClip(page, theme, 'projects-done', box);
        // Collapse it again: an expanded Done group pushes the unknown-status
        // group (shot 12) below the fold.
        await section.locator('.group-header').first().click();
        await settle(page, 400);
      } else {
        console.warn(`[shoot] ${theme}/projects-done: "done" section not present in fixture`);
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);

    // 4. code-pane — the Code pane alone, filling the window. The composite
    //    50/50 view is already `dashboard-overview`; this shot exists so the
    //    repo cards (branch pill, dirty count, the open-with buttons) are
    //    legible, which they are not at 798px next to the Projects list.
    //    Captured with NO popover open: the page it serves
    //    (`repositories-and-open-with.md`) is about the card list, and the
    //    popover covers one of the five cards.
    await setProjectsBand(b, false);
    await settle(page, 600);
    await parkPointer(page);
    await requireContent(page, 'code-pane', {
      root: '.repos-pane',
      items: '.repo-row',
      minItems: 5,
    });
    await shoot(page, theme, 'code-pane');

    // 5. code-pane-dirty — the same pane with helio's dirty-file popover open.
    //    `daily-loop.md` §2 promises "a dirty-file indicator", and the popover
    //    is what that badge is for; it gets its own slug so the card-list shot
    //    above stays unobstructed.
    {
      const dirty = page.locator('.branch-dirty').first();
      if (await dirty.count()) {
        await dirty.click();
        await page.locator('.branch-dirty-popover').first().waitFor({ state: 'visible' });
        await settle(page, 600);
      }
    }
    await requireContent(page, 'code-pane-dirty', {
      root: '.branch-dirty-popover',
      text: 'README.md',
    });
    await shoot(page, theme, 'code-pane-dirty');
    await page.keyboard.press('Escape');
    await setProjectsBand(b, true);
    await showLeftView(page, 'Projects');

    // 6. knowledge-pane — the tree's directory sections are pre-expanded via
    //    the seeded `treeExpansion`, so the shot shows the tree, not three
    //    collapsed headers.
    await showWorking(b, 'Knowledge');
    await parkPointer(page);
    // Collapsed directory sections render zero cards — the failure this probe
    // exists for.
    await requireContent(page, 'knowledge-pane', {
      root: '.knowledge-pane',
      items: '.knowledge-card',
      minItems: 4,
    });
    await shoot(page, theme, 'knowledge-pane');

    // 7. resources-pane — the fixture's resources/ has 2 root files and one
    //    subdir (notes/) so the pane renders a ROOT and a NOTES section.
    await showWorking(b, 'Resources');
    await settle(page, 400);
    await parkPointer(page);
    await requireContent(page, 'resources-pane', {
      root: '.resources-pane',
      items: '.resources-card',
      minItems: 3,
    });
    await shoot(page, theme, 'resources-pane');

    // 8. skills-pane — the fixture ships `AGENTS.md` (pinned as the read-only
    //    callout) plus two `.agents/skills/<slug>/SKILL.md` directories, so the
    //    pane renders the callout, both index badges, and a companion file.
    await showWorking(b, 'Skills');
    await settle(page, 400);
    await parkPointer(page);
    // The "No skills available" empty state renders `.empty.pane-empty` and no
    // cards — it shipped once because a full-window shot of it looks normal.
    await requireContent(page, 'skills-pane', {
      root: '.skills-pane',
      items: '.skills-card',
      minItems: 2,
    });
    await shoot(page, theme, 'skills-pane');

    await showWorking(b, 'Code');

    // 9. terminal — open the band, spawn a shell from the tab-strip dropdown,
    //    and run a command so the body actually carries output. The demo shell
    //    puts a stub `helio` on PATH and pins PS1, so the prompt shows neither
    //    the host's username nor its hostname.
    await sendMenu(b.app, 'toggle-terminal');
    await settle(page, 600);
    {
      const dropdown = page.locator('.terminal-tab-dropdown').first();
      await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
      await dropdown.click();
      await page
        .locator('.terminal-tab-dropdown-menu li', { hasText: 'New shell' })
        .first()
        .click();
      await page.locator('.terminal-host .xterm-screen').first().waitFor({ state: 'visible' });
      await settle(page, 1200);
      await page.locator('.terminal-host').first().click();
      await page.keyboard.type("helio search --engine=trigram 'ERROR 5[0-9][0-9]'");
      await page.keyboard.press('Enter');
      await settle(page, 1200);
    }
    await parkPointer(page);
    await requireContent(page, 'terminal', { root: '.terminal-host' });
    {
      // The band being mounted is not the same claim as the body carrying
      // output: the committed `terminal-*.png` pair had a full, correctly-sized
      // band around a completely empty xterm. Read the buffer itself.
      const terminalText = await readTerminalText(page);
      expect(terminalText, 'terminal: the xterm buffer has no command line').toContain(
        'helio search',
      );
      expect(terminalText, 'terminal: the xterm buffer has no command output').toContain('3 hits');
    }
    await shoot(page, theme, 'terminal');

    // 10. spawn-dropdown — the same tab strip with the launcher menu open, which
    //     is where a configured agent is picked. The seeded agents mark two as
    //     `favorite`, so the menu shows the favourites inline and the rest
    //     behind `More ▸` — open the fly-out so both levels are visible.
    {
      const dropdown = page.locator('.terminal-tab-dropdown').first();
      await dropdown.click();
      await page.locator('.terminal-tab-dropdown-menu').first().waitFor({ state: 'visible' });
      const more = page.locator('.terminal-tab-dropdown-more').first();
      if (await more.count()) {
        await more.click();
        await page.locator('.terminal-tab-dropdown-submenu').first().waitFor({ state: 'visible' });
      }
      await settle(page, 400);
      await requireContent(page, 'spawn-dropdown', {
        root: '.terminal-tab-dropdown-menu',
        items: 'li',
        minItems: 3,
      });
      await shoot(page, theme, 'spawn-dropdown');
      await page.keyboard.press('Escape');
      await settle(page);
    }
    await sendMenu(b.app, 'toggle-terminal');
    await settle(page, 400);

    // 11. item-fuzzy-search — the global search modal over the dashboard.
    await sendMenu(b.app, 'search');
    await settle(page);
    // Scoped to the modal: the Projects pane's own filter bar also has an
    // input whose placeholder says "Search", and it sits earlier in the DOM.
    const searchInput = page.locator('.search-modal input').first();
    if (await searchInput.count()) {
      await searchInput.fill('fuzzy');
      await settle(page, 600);
    }
    await parkPointer(page);
    await requireContent(page, 'item-fuzzy-search', {
      root: '.search-modal',
      items: '.search-result',
      minItems: 3,
    });
    await shoot(page, theme, 'item-fuzzy-search');
    await page.keyboard.press('Escape');
    await settle(page);

    // 12. item-document-with-pdf — open a document item that has a PDF
    //     deliverable. The demo fixture's `2026-04-10-plugin-api-proposal/
    //     deliverables/` ships a PDF; click that card to open the note modal.
    await showLeftView(page, 'Projects');
    const docCard = page.locator('.row', { hasText: /plugin API proposal/i }).first();
    if (await docCard.count()) {
      await docCard.click();
      await settle(page, 500);
    }
    await parkPointer(page);
    await requireContent(page, 'item-document-with-pdf', {
      root: '.project-preview',
      text: 'Deliverables',
    });
    await shoot(page, theme, 'item-document-with-pdf');
    await page.keyboard.press('Escape');
    await settle(page);

    // 13. status-unknown-badge — the demo fixture's `2026-04-18-typo-status-demo`
    //     intentionally carries a non-canonical status so the warn badge renders.
    //     Match on the card's rendered title: the slug is not in the DOM, so the
    //     old `/typo|status-demo/` filter never matched and never scrolled.
    const unknownRow = page.locator('.row', { hasText: /unknown Status value/i }).first();
    if (await unknownRow.count()) {
      await unknownRow.scrollIntoViewIfNeeded();
      await settle(page, 400);
    }
    await parkPointer(page);
    // Presence is not enough here — the whole point of this shot is that the
    // card is IN FRAME, which is exactly what the old filter silently lost.
    await expect(
      unknownRow,
      'status-unknown-badge: the `?` card is not in the captured frame',
    ).toBeInViewport({ ratio: 0.9 });
    await shoot(page, theme, 'status-unknown-badge');
    await page.evaluate(() => window.scrollTo(0, 0));

    // 14. tasks-pane — the left band's Tasks view. The fixture ships two
    //     `tasks/<slug>/{task.json,prompt.md}` directories whose `agent` ids
    //     resolve against the seeded agents list, so Run… is enabled.
    await showLeftView(page, 'Tasks');
    await settle(page, 500);
    await parkPointer(page);
    await requireContent(page, 'tasks-pane', {
      root: '.tasks-pane',
      items: '.tasks-row',
      minItems: 2,
    });
    await shoot(page, theme, 'tasks-pane');

    // 15. deliverables-pane — the left band's Deliverables view, aggregating
    //     every `## Deliverables` section. The fixture exercises the wiki /
    //     url / pdf / md / image / file type tags.
    await showLeftView(page, 'Deliverables');
    await settle(page, 500);
    await parkPointer(page);
    await requireContent(page, 'deliverables-pane', {
      root: '.deliverables-stack',
      items: '.deliverable-button',
      minItems: 6,
    });
    await shoot(page, theme, 'deliverables-pane');

    // 16. plan-document — the MDX viewer, opened from the plan deliverable of
    //     `2026-04-02-fuzzy-search-v2`.
    {
      const planRow = page
        .locator('.deliverable-button', { hasText: 'Trigram index plan' })
        .first();
      if (await planRow.count()) {
        await planRow.click();
        await page.locator('.mdx-modal').waitFor({ state: 'visible', timeout: 10_000 });
        await settle(page, 800);
        await parkPointer(page);
        await requireContent(page, 'plan-document', {
          root: '.mdx-modal',
          items: '.plan-block',
          minItems: 4,
        });
        await shoot(page, theme, 'plan-document');
        await page.keyboard.press('Escape');
        await settle(page);
      } else {
        console.warn(`[shoot] ${theme}/plan-document: plan deliverable not found`);
      }
    }
    await showLeftView(page, 'Projects');

    // 17. settings-modal — opened, never saved.
    await sendMenu(b.app, 'open-settings');
    await page.locator('.settings-modal').waitFor({ state: 'visible', timeout: 10_000 });
    await settle(page, 800);
    await parkPointer(page);
    await requireContent(page, 'settings-modal', {
      root: '.settings-modal',
      items: '.settings-rail-item',
      minItems: 6,
    });
    await shoot(page, theme, 'settings-modal');
    await page.keyboard.press('Escape');
    await settle(page);
  } finally {
    await shutdown(b);
  }
}

test('capture every documentation screenshot in light + dark', async () => {
  test.setTimeout(420_000);
  await rm(outRoot, { recursive: true, force: true });
  await captureForTheme('light');
  await captureForTheme('dark');

  // File-level checks, deliberately coarse: every slug exists in both themes,
  // clears a size floor (the sliver failure signature was 1.7 kB), and — for
  // the full-window shots — is actually 3200×2200, the guard for the
  // capture-scale regression that silently halved every xterm glyph. They
  // replace an `expect(true).toBe(true)` that let three broken shots reach
  // docs/, and they catch a missing file (`shoot()` swallows its own errors), a
  // degenerate clip, and a wrong capture scale.
  //
  // What they CANNOT catch is a full-window shot whose target pane is blank or
  // empty — the surrounding chrome dominates the byte count. That is what the
  // per-slug `requireContent()` probes above are for. Neither layer replaces
  // opening the images: a green run says the surfaces were populated, not that
  // they look right.
  const missing: string[] = [];
  const undersized: string[] = [];
  const wrongSize: string[] = [];
  for (const theme of ['light', 'dark'] as Theme[]) {
    for (const { slug, minBytes } of EXPECTED_SHOTS) {
      const file = join(outRoot, theme, `${slug}.png`);
      const png = await readFile(file).catch(() => null);
      if (!png) {
        missing.push(`${theme}/${slug}.png`);
        continue;
      }
      if (png.byteLength < minBytes) {
        undersized.push(`${theme}/${slug}.png (${png.byteLength} < ${minBytes})`);
      }
      const { width, height } = pngSize(png);
      const clipped = CLIPPED_SHOTS.has(slug);
      const expected = `${VIEWPORT.width * DEVICE_SCALE}×${VIEWPORT.height * DEVICE_SCALE}`;
      if (clipped) {
        // A clip is smaller than the window by definition; assert only that it
        // is not the degenerate sliver a collapsed section produces.
        if (width < 100 || height < 100) wrongSize.push(`${theme}/${slug}.png ${width}×${height}`);
      } else if (
        width !== VIEWPORT.width * DEVICE_SCALE ||
        height !== VIEWPORT.height * DEVICE_SCALE
      ) {
        wrongSize.push(`${theme}/${slug}.png ${width}×${height}, expected ${expected}`);
      }
    }
  }
  expect(missing, `missing screenshots: ${missing.join(', ')}`).toEqual([]);
  expect(undersized, `implausibly small screenshots: ${undersized.join(', ')}`).toEqual([]);
  expect(wrongSize, `wrong capture size: ${wrongSize.join(', ')}`).toEqual([]);
});
