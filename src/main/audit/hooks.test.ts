/**
 * Tests for the `hooks` audit check — a hook script no settings file
 * registers, which looks live from the outside and never runs.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHooks } from './hooks';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'condash-hooks-audit-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeHook(name = 'knowledge-retrieve-reminder.sh'): Promise<void> {
  await fs.mkdir(join(root, '.claude/hooks'), { recursive: true });
  await fs.writeFile(join(root, '.claude/hooks', name), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
}

async function writeSettings(body: unknown, file = 'settings.json'): Promise<void> {
  await fs.mkdir(join(root, '.claude'), { recursive: true });
  await fs.writeFile(join(root, '.claude', file), JSON.stringify(body, null, 2), 'utf8');
}

function hookSettings(command: string): unknown {
  return {
    hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command }] }] },
  };
}

describe('checkHooks', () => {
  it('returns nothing when the conception has no hooks directory', async () => {
    expect(await checkHooks(root)).toEqual([]);
  });

  it('flags a hook that no settings file registers', async () => {
    await writeHook();
    const issues = await checkHooks(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('hooks');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].file).toBe('.claude/hooks/knowledge-retrieve-reminder.sh');
    expect(issues[0].fix.autoFix).toBe(false);
    expect(issues[0].message).toContain('no hooks are registered at all');
  });

  it('stays silent once a settings file registers the hook', async () => {
    await writeHook();
    await writeSettings(
      hookSettings('bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/knowledge-retrieve-reminder.sh'),
    );
    expect(await checkHooks(root)).toEqual([]);
  });

  it('accepts a registration in the local settings file', async () => {
    await writeHook();
    await writeSettings(
      hookSettings('bash ${CLAUDE_PROJECT_DIR}/.claude/hooks/knowledge-retrieve-reminder.sh'),
      'settings.local.json',
    );
    expect(await checkHooks(root)).toEqual([]);
  });

  it('flags only the unregistered hook when a sibling is registered', async () => {
    await writeHook();
    await writeHook('projects-validate.sh');
    await writeSettings(hookSettings('bash .claude/hooks/projects-validate.sh'));
    const issues = await checkHooks(root);
    expect(issues.map((i) => i.file)).toEqual(['.claude/hooks/knowledge-retrieve-reminder.sh']);
    // The "nothing is registered" wording is reserved for a settings file with
    // no hooks at all, so it must not appear here.
    expect(issues[0].message).not.toContain('no hooks are registered at all');
  });

  it('does not report a hook a malformed settings file mentions', async () => {
    // A trailing comma must not turn a live hook into a reported one: the
    // fallback scans the raw text rather than assuming nothing is registered.
    await writeHook();
    await fs.mkdir(join(root, '.claude'), { recursive: true });
    await fs.writeFile(
      join(root, '.claude/settings.json'),
      '{ "hooks": { "PreToolUse": [ { "command": "bash .claude/hooks/knowledge-retrieve-reminder.sh" }, ] } }',
      'utf8',
    );
    expect(await checkHooks(root)).toEqual([]);
  });
});
