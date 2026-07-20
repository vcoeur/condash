/**
 * Tests for projects-mutate: statusCommand (get/set), closeProject,
 * reopenProject. Each test seeds a single project README in the tmp
 * conception, runs the verb, and inspects the README + output envelope.
 */
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  statusCommand,
  closeProject,
  reopenProject,
  checkKnowledgeCommand,
} from './projects-mutate';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
  writeProjectReadme,
} from './test-helpers';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await makeTmpConception();
});

afterEach(async () => {
  await rmConception(conceptionPath);
});

describe('statusCommand get', () => {
  it('returns the current status', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { stdout, threw } = await captureStdout(() =>
      statusCommand(
        { noun: 'projects', verb: 'status', positional: ['get', 'alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ status: string }>(stdout).data!;
    expect(data.status).toBe('now');
  });

  it('USAGE when slug is missing', async () => {
    const { threw } = await captureStdout(() =>
      statusCommand(
        { noun: 'projects', verb: 'status', positional: ['get'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('statusCommand set', () => {
  it('flips the status and appends a timeline entry', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
      body: '## Timeline\n\n',
    });
    const { threw } = await captureStdout(() =>
      statusCommand(
        {
          noun: 'projects',
          verb: 'status',
          positional: ['set', 'alpha', 'review'],
          flags: {},
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const updated = await fs.readFile(readme, 'utf8');
    expect(updated).toMatch(/status: review/);
  });

  it('rejects an unknown status with VALIDATION', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { threw } = await captureStdout(() =>
      statusCommand(
        {
          noun: 'projects',
          verb: 'status',
          positional: ['set', 'alpha', 'banana'],
          flags: {},
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });

  it('USAGE when status is missing', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { threw } = await captureStdout(() =>
      statusCommand(
        { noun: 'projects', verb: 'status', positional: ['set', 'alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('closeProject', () => {
  it('flips status → done and writes a Closed timeline entry', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
      body: '## Timeline\n\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      closeProject(
        {
          noun: 'projects',
          verb: 'close',
          positional: ['alpha'],
          flags: { summary: 'Shipped in v3.10.4' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ newStatus: string }>(stdout).data!;
    expect(data.newStatus).toBe('done');
    const updated = await fs.readFile(readme, 'utf8');
    expect(updated).toMatch(/status: done/);
    expect(updated).toMatch(/—\s+Closed\.\s+Shipped in v3\.10\.4/);
    expect(updated).toMatch(/—\s+Checked knowledge promotion/);
  });

  it('USAGE when slug is missing', async () => {
    const { threw } = await captureStdout(() =>
      closeProject(
        { noun: 'projects', verb: 'close', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('checkKnowledgeCommand', () => {
  it('reports NEEDS CHECK for a done project whose last entry is not the marker, without mutating', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const before = await fs.readFile(readme, 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      checkKnowledgeCommand(
        { noun: 'projects', verb: 'check-knowledge', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ status: string; satisfied: boolean; needsCheck: boolean }>(
      stdout,
    ).data!;
    expect(data.status).toBe('done');
    expect(data.satisfied).toBe(false);
    expect(data.needsCheck).toBe(true);
    // Signal only — the file must be untouched.
    expect(await fs.readFile(readme, 'utf8')).toBe(before);
  });

  it('reports satisfied when the marker is the last timeline entry', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n- 2026-05-02 — Checked knowledge promotion\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      checkKnowledgeCommand(
        { noun: 'projects', verb: 'check-knowledge', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ satisfied: boolean; needsCheck: boolean }>(stdout).data!;
    expect(data.satisfied).toBe(true);
    expect(data.needsCheck).toBe(false);
  });

  it('reports not-required for a non-done project, without mutating', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
      body: '## Timeline\n\n',
    });
    const before = await fs.readFile(readme, 'utf8');
    const { stdout, threw } = await captureStdout(() =>
      checkKnowledgeCommand(
        { noun: 'projects', verb: 'check-knowledge', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ status: string; needsCheck: boolean }>(stdout).data!;
    expect(data.status).toBe('now');
    expect(data.needsCheck).toBe(false);
    expect(await fs.readFile(readme, 'utf8')).toBe(before);
  });

  it('--record appends a dated "Checked knowledge promotion" marker', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      checkKnowledgeCommand(
        {
          noun: 'projects',
          verb: 'check-knowledge',
          positional: ['alpha'],
          flags: { record: true },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ recorded: boolean }>(stdout).data!;
    expect(data.recorded).toBe(true);
    const updated = await fs.readFile(readme, 'utf8');
    // Marker is the last timeline entry and carries a complete date.
    expect(updated).toMatch(/-\s+\d{4}-\d{2}-\d{2}\s+—\s+Checked knowledge promotion\s*$/);
  });

  it('USAGE when slug is missing', async () => {
    const { threw } = await captureStdout(() =>
      checkKnowledgeCommand(
        { noun: 'projects', verb: 'check-knowledge', positional: [], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(2);
  });
});

describe('reopenProject', () => {
  it('flips a done project back to now', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const { threw } = await captureStdout(() =>
      reopenProject(
        { noun: 'projects', verb: 'reopen', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const updated = await fs.readFile(readme, 'utf8');
    expect(updated).toMatch(/status: now/);
  });

  it('accepts --summary and writes it into the Reopened timeline entry', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      reopenProject(
        {
          noun: 'projects',
          verb: 'reopen',
          positional: ['alpha'],
          flags: { status: 'now', summary: 'why it came back' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    // The documented flag must be accepted, not rejected by assertNoExtraFlags.
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ newStatus: string; timelineAppended: string }>(stdout).data!;
    expect(data.newStatus).toBe('now');
    expect(data.timelineAppended).toMatch(/^- \d{4}-\d{2}-\d{2} — Reopened\. why it came back\.$/);
    const updated = await fs.readFile(readme, 'utf8');
    expect(updated).toMatch(/status: now/);
    expect(updated).toMatch(/—\s+Reopened\.\s+why it came back\./);
  });

  it('lands a bare Reopened entry when --summary is omitted', async () => {
    const readme = await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
      body: '## Timeline\n\n- 2026-05-02 — Closed.\n',
    });
    const { stdout, threw } = await captureStdout(() =>
      reopenProject(
        { noun: 'projects', verb: 'reopen', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeUndefined();
    const data = parseJsonEnvelope<{ timelineAppended: string }>(stdout).data!;
    expect(data.timelineAppended).toMatch(/^- \d{4}-\d{2}-\d{2} — Reopened\.$/);
    const updated = await fs.readFile(readme, 'utf8');
    expect(updated).toMatch(/-\s+\d{4}-\d{2}-\d{2}\s+—\s+Reopened\.\s*$/m);
  });

  it('rejects reopening a project that is not done', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'now',
      title: 'Alpha',
    });
    const { threw } = await captureStdout(() =>
      reopenProject(
        { noun: 'projects', verb: 'reopen', positional: ['alpha'], flags: {} },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });

  it('rejects --status done as a reopen target', async () => {
    await writeProjectReadme(conceptionPath, 'alpha', {
      date: '2026-05-01',
      kind: 'project',
      status: 'done',
      title: 'Alpha',
    });
    const { threw } = await captureStdout(() =>
      reopenProject(
        {
          noun: 'projects',
          verb: 'reopen',
          positional: ['alpha'],
          flags: { status: 'done' },
        },
        jsonCtx(),
        conceptionPath,
      ),
    );
    expect(threw).toBeInstanceOf(CliError);
    expect((threw as CliError).exitCode).toBe(3);
  });
});
