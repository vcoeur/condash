import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../shared/types';
import type { TaskDef } from '../shared/tasks';
import { deleteTask, listTasks, readTask, writeTask } from './tasks';

let dir: string;
let xdgDir: string;
let prevXdg: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'condash-tasks-'));
  // Point the global settings dir at an empty tmp dir so `listAgents` (which
  // reads the effective config = global settings.json overlaid by the
  // conception's condash.json) doesn't pick up the dev machine's real agents.
  xdgDir = await fs.mkdtemp(join(tmpdir(), 'condash-xdg-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgDir;
});
afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(xdgDir, { recursive: true, force: true });
});

/** Seed the conception's `agents` list (the source `listTasks` resolves
 *  agent presence against). */
async function seedAgents(agents: Agent[]): Promise<void> {
  await fs.writeFile(join(dir, 'condash.json'), JSON.stringify({ agents }, null, 2), 'utf8');
}

const deepseekAgent: Agent = {
  id: 'claude-deepseek-v4-pro',
  label: 'DeepSeek v4 Pro',
  command: 'claude',
};

const task: TaskDef = {
  // `agent` references the agent by its stable id from the `agents` list.
  name: 'Refresh app docs',
  agent: 'claude-deepseek-v4-pro',
  submit: true,
  prompt: 'Review {APP} and update its docs. Focus: {AREA:CLAUDE.md and docs/}',
};

describe('task storage round-trip', () => {
  it('writes task.json + prompt.md and reads them back', async () => {
    const slug = await writeTask(dir, 'refresh-app-docs', task);
    expect(slug).toBe('refresh-app-docs');
    await fs.access(join(dir, 'tasks', 'refresh-app-docs', 'task.json'));
    await fs.access(join(dir, 'tasks', 'refresh-app-docs', 'prompt.md'));

    const back = await readTask(dir, 'refresh-app-docs');
    expect(back).toEqual(task);
  });

  it('stores only name/agent/submit in task.json (prose stays in prompt.md)', async () => {
    await writeTask(dir, 'refresh-app-docs', task);
    const config = JSON.parse(
      await fs.readFile(join(dir, 'tasks', 'refresh-app-docs', 'task.json'), 'utf8'),
    );
    expect(config).toEqual({
      name: 'Refresh app docs',
      agent: 'claude-deepseek-v4-pro',
      submit: true,
    });
    expect(config).not.toHaveProperty('prompt');
  });

  it('defaults submit to true when task.json omits it', async () => {
    const tasksDir = join(dir, 'tasks', 'no-submit');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(join(tasksDir, 'task.json'), JSON.stringify({ name: 'X', agent: 'a' }));
    await fs.writeFile(join(tasksDir, 'prompt.md'), 'hello');
    const back = await readTask(dir, 'no-submit');
    expect(back).toEqual({ name: 'X', agent: 'a', submit: true, prompt: 'hello' });
  });
});

describe('listTasks', () => {
  it('returns [] when the tasks dir is absent', async () => {
    expect(await listTasks(dir)).toEqual([]);
  });

  it('lists tasks with parsed markers and agent presence', async () => {
    await seedAgents([deepseekAgent]); // makes the referenced agent resolve
    await writeTask(dir, 'refresh-app-docs', task);

    const items = await listTasks(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      slug: 'refresh-app-docs',
      name: 'Refresh app docs',
      agent: 'claude-deepseek-v4-pro',
      agentPresent: true,
    });
    expect(items[0].markers).toEqual([
      { key: 'APP', default: '' },
      { key: 'AREA', default: 'CLAUDE.md and docs/' },
    ]);
  });

  it('flags a dangling agent as absent', async () => {
    await writeTask(dir, 'refresh-app-docs', task); // no agent defined
    const items = await listTasks(dir);
    expect(items[0].agentPresent).toBe(false);
  });

  it('sorts by name and skips entries without task.json', async () => {
    await writeTask(dir, 'zebra', { ...task, name: 'Zebra' });
    await writeTask(dir, 'apple', { ...task, name: 'Apple' });
    await fs.mkdir(join(dir, 'tasks', 'stray-dir'), { recursive: true }); // no task.json
    const names = (await listTasks(dir)).map((t) => t.name);
    expect(names).toEqual(['Apple', 'Zebra']);
  });
});

describe('writeTask rename + deleteTask', () => {
  it('rename via previousSlug removes the old directory', async () => {
    await writeTask(dir, 'old-slug', task);
    await writeTask(dir, 'new-slug', task, 'old-slug');
    const slugs = (await listTasks(dir)).map((t) => t.slug);
    expect(slugs).toEqual(['new-slug']);
  });

  it('rejects a rename onto a slug that already holds another task', async () => {
    await writeTask(dir, 'keep', { ...task, name: 'Keep' });
    await writeTask(dir, 'rename-me', { ...task, name: 'Rename me' });
    await expect(writeTask(dir, 'keep', task, 'rename-me')).rejects.toThrow(/already exists/);
    // Both survive: the target was not clobbered and the source was not deleted.
    const slugs = (await listTasks(dir)).map((t) => t.slug);
    expect(slugs).toEqual(['keep', 'rename-me']);
  });

  it('deleteTask is idempotent', async () => {
    await writeTask(dir, 'refresh-app-docs', task);
    await deleteTask(dir, 'refresh-app-docs');
    await deleteTask(dir, 'refresh-app-docs');
    expect(await listTasks(dir)).toEqual([]);
  });
});

describe('slug validation', () => {
  it('rejects an invalid slug', async () => {
    await expect(writeTask(dir, 'Bad Slug!', task)).rejects.toThrow(/invalid task slug/);
  });

  it('rejects a traversal slug on read', async () => {
    await expect(readTask(dir, '../escape')).rejects.toThrow(/invalid task slug/);
  });
});
