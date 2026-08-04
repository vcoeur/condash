/**
 * createProject IPC handler tests — the Medium-4 review findings:
 *
 *   1. The handler's `input` payload must go through `requireRecord`, so a
 *      null / non-object renderer payload rejects with the uniform
 *      `<channel>: expected an object` decoder error instead of a bare
 *      TypeError.
 *   2. `createProjectCore` (shared by CLI + GUI) must reject any status
 *      outside CREATE_STATUSES — which also closes the raw `status:`
 *      front-matter interpolation (a newline-injected status could otherwise
 *      smuggle extra YAML keys into the README).
 *
 * Handlers are private; we capture them off a mocked `ipcMain.handle` and
 * call them directly, exactly like logs.test.ts. The mock `readSettings`
 * points at a tmp conception so createProjectCore can write for real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings', async () => {
  const actual = await vi.importActual<typeof import('../settings')>('../settings');
  return {
    ...actual,
    readSettings: vi.fn(async () => ({
      lastConceptionPath: (globalThis as { __testConception?: string }).__testConception ?? null,
    })),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/electron-app' },
}));

let handlers: Record<string, (...args: any[]) => Promise<unknown>>;

/** Minimal event shape accepted by `requireMainWindowSender`. */
const trustedEvent = {
  sender: { getType: () => 'window' },
  senderFrame: { url: 'file:///app/dist/index.html', parent: null },
};

let tmp: string;

beforeEach(async () => {
  handlers = {};
  const { ipcMain } = await import('electron');
  (ipcMain.handle as any).mockImplementation(
    (channel: string, fn: (...args: any[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    },
  );
  const { registerProjectsIpc } = await import('./projects');
  registerProjectsIpc();

  tmp = mkdtempSync(join(tmpdir(), 'condash-projects-ipc-'));
  (globalThis as { __testConception?: string }).__testConception = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete (globalThis as { __testConception?: string }).__testConception;
});

/** Every README.md found anywhere under `<tmp>/projects/` — empty when
 * nothing was created. */
async function readmesUnderProjects(): Promise<string[]> {
  const found: string[] = [];
  try {
    const months = await fsp.readdir(join(tmp, 'projects'));
    for (const month of months) {
      const dirs = await fsp.readdir(join(tmp, 'projects', month));
      for (const dir of dirs) {
        const readmePath = join(tmp, 'projects', month, dir, 'README.md');
        try {
          await fsp.access(readmePath);
          found.push(readmePath);
        } catch {
          // dir without a README — not an item.
        }
      }
    }
  } catch {
    // projects/ doesn't exist — nothing was created.
  }
  return found;
}

describe('createProject payload guard', () => {
  it('rejects a null payload with the uniform decoder error', async () => {
    await expect(handlers.createProject(trustedEvent, null)).rejects.toThrow(
      /createProject: expected an object/,
    );
  });

  it('rejects a non-object payload (string) with the uniform decoder error', async () => {
    await expect(handlers.createProject(trustedEvent, 'oops')).rejects.toThrow(
      /createProject: expected an object/,
    );
  });

  it('rejects an array payload with the uniform decoder error', async () => {
    await expect(handlers.createProject(trustedEvent, ['kind'])).rejects.toThrow(
      /createProject: expected an object/,
    );
  });
});

describe('createProject status validation', () => {
  it('rejects an unknown status via createProjectCore and writes nothing', async () => {
    await expect(
      handlers.createProject(trustedEvent, {
        kind: 'project',
        slug: 'foo',
        title: 'Foo',
        status: 'bogus',
      }),
    ).rejects.toThrow(/--status must be one of \{now, review, later, backlog\}/);
    expect(await readmesUnderProjects()).toEqual([]);
  });

  it('rejects a newline-injected status (YAML injection attempt) and writes nothing', async () => {
    await expect(
      handlers.createProject(trustedEvent, {
        kind: 'project',
        slug: 'foo',
        title: 'Foo',
        status: 'now\nparent: 2026-01-01-x',
      }),
    ).rejects.toThrow(/--status must be one of/);
    expect(await readmesUnderProjects()).toEqual([]);
  });

  it('creates a project with a valid status', async () => {
    const result = (await handlers.createProject(trustedEvent, {
      kind: 'project',
      slug: 'foo',
      title: 'Foo',
      status: 'now',
    })) as { path: string; readme: string };
    expect(result.path).toBeTruthy();
    expect(result.path).toMatch(/-foo$/);
    const readme = await fsp.readFile(result.readme, 'utf8');
    expect(readme).toMatch(/^status: now$/m);
  });
});
