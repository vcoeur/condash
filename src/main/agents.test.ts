import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_PRESETS, type AgentDef } from '../shared/harnesses';
import {
  agentsEnvPath,
  deleteAgent,
  listAgents,
  parseEnv,
  previewAgent,
  readAgent,
  resolveAgentSpawn,
  writeAgent,
} from './agents';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'condash-agents-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const claudeAgent: AgentDef = {
  harness: 'claude',
  modelVariant: 'deepseek-v4-pro',
  secretEnv: 'DEEPSEEK_API_KEY',
  config: CLAUDE_PRESETS['deepseek-v4-pro'].config,
};

describe('parseEnv', () => {
  it('parses KEY=value lines, ignoring comments/blanks and stripping quotes', () => {
    expect(parseEnv('# c\n\nA=1\nB="two"\nC=\nbad line\n')).toEqual({ A: '1', B: 'two', C: '' });
  });
});

describe('agent storage round-trip', () => {
  it('writes a derived filename and lists it back with token presence', async () => {
    const name = await writeAgent(dir, claudeAgent);
    expect(name).toBe('claude-deepseek-v4-pro');
    await fs.access(join(dir, 'agents', 'claude-deepseek-v4-pro.json'));

    // No .env yet → token absent.
    let items = await listAgents(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name, harness: 'claude', tokenPresent: false });

    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    items = await listAgents(dir);
    expect(items[0].tokenPresent).toBe(true);

    const def = await readAgent(dir, name);
    expect(def?.harness).toBe('claude');
  });

  it('rename via previousName removes the old file', async () => {
    await writeAgent(dir, claudeAgent);
    const renamed: AgentDef = { ...claudeAgent, modelVariant: 'deepseek-v4-flash' };
    await writeAgent(dir, renamed, 'claude-deepseek-v4-pro');
    const names = (await listAgents(dir)).map((a) => a.name);
    expect(names).toEqual(['claude-deepseek-v4-flash']);
  });

  it('deleteAgent is idempotent', async () => {
    await writeAgent(dir, claudeAgent);
    await deleteAgent(dir, 'claude-deepseek-v4-pro');
    await deleteAgent(dir, 'claude-deepseek-v4-pro');
    expect(await listAgents(dir)).toEqual([]);
  });

  it('listAgents returns [] when the agents dir is absent', async () => {
    expect(await listAgents(dir)).toEqual([]);
  });
});

describe('resolveAgentSpawn', () => {
  it('injects the real token from agents/.env', async () => {
    await writeAgent(dir, claudeAgent);
    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    const spec = await resolveAgentSpawn(dir, 'claude-deepseek-v4-pro');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-real');
  });

  it('throws when the token is missing', async () => {
    await writeAgent(dir, claudeAgent);
    await expect(resolveAgentSpawn(dir, 'claude-deepseek-v4-pro')).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );
  });
});

describe('previewAgent', () => {
  it('masks the token as a $SECRET_ENV reference', async () => {
    await writeAgent(dir, claudeAgent);
    await fs.writeFile(agentsEnvPath(dir), 'DEEPSEEK_API_KEY=sk-real\n');
    const preview = await previewAgent(dir, 'claude-deepseek-v4-pro');
    expect(preview?.env.ANTHROPIC_AUTH_TOKEN).toBe('$DEEPSEEK_API_KEY');
    expect(JSON.stringify(preview)).not.toContain('sk-real');
  });
});
