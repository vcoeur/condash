/**
 * Behavioural coverage for the three sharp edges fixed by 2026-05-16-condash-
 * cli-ux-fixes:
 *
 *   B1 — `condash projects <verb> --help` always wins over required-arg checks.
 *   B2 — Unknown flags surface BEFORE missing-required errors, with a
 *        `(did you mean --X?)` suggestion drawn from the noun-wide flag pool.
 *   B3 — `condash projects create --status <s>` accepted; `done` rejected.
 *
 * Tests run against `runProjects` (B1) and `createCommand` (B2/B3) directly.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProjects } from './projects';
import { createCommand } from './projects-maintenance';
import type { OutputContext } from '../output';
import { CliError } from '../output';

let conceptionPath: string;

beforeEach(async () => {
  conceptionPath = await fs.mkdtemp(join(tmpdir(), 'projects-create-'));
  // Minimal scaffolding — projects/ tree is created lazily by createCommand.
});

afterEach(async () => {
  await fs.rm(conceptionPath, { recursive: true, force: true });
});

function ctx(): OutputContext {
  return { json: false, ndjson: false, quiet: true, noColor: true };
}

function captureStdout(
  fn: () => Promise<void> | void,
): Promise<{ stdout: string; threw: unknown }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((data: string | Uint8Array) => {
      chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          process.stdout.write = orig;
          resolve({ stdout: chunks.join(''), threw: undefined });
        },
        (err) => {
          process.stdout.write = orig;
          resolve({ stdout: chunks.join(''), threw: err });
        },
      );
  });
}

describe('B1 — `--help` always wins', () => {
  it('prints create-help instead of complaining about missing --apps', async () => {
    const { stdout, threw } = await captureStdout(async () => {
      await runProjects(
        'create',
        { noun: 'projects', verb: 'create', positional: [], flags: {} },
        ctx(),
        conceptionPath,
        true, // universalHelp
      );
    });
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash projects create/);
    expect(stdout).toMatch(/--apps/);
    expect(stdout).not.toMatch(/--apps is required/);
  });

  it('prints help when --help is combined with a typo', async () => {
    const { stdout, threw } = await captureStdout(async () => {
      await runProjects(
        'create',
        { noun: 'projects', verb: 'create', positional: [], flags: { app: 'foo' } },
        ctx(),
        conceptionPath,
        true,
      );
    });
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash projects create/);
  });

  it('routes `condash projects help create` (positional alias) to create-help', async () => {
    const { stdout, threw } = await captureStdout(async () => {
      await runProjects(
        'help',
        { noun: 'projects', verb: 'help', positional: ['create'], flags: {} },
        ctx(),
        conceptionPath,
        false,
      );
    });
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash projects create/);
    expect(stdout).toMatch(/--apps/);
  });

  it('--help on `read` (which requires a slug positional) prints help', async () => {
    const { stdout, threw } = await captureStdout(async () => {
      await runProjects(
        'read',
        { noun: 'projects', verb: 'read', positional: [], flags: {} },
        ctx(),
        conceptionPath,
        true,
      );
    });
    expect(threw).toBeUndefined();
    expect(stdout).toMatch(/condash projects read/);
    expect(stdout).not.toMatch(/Usage: condash projects read/);
  });
});

describe('B2 — typo-first validation', () => {
  it('rejects --app (typo of --apps) with a suggestion BEFORE missing-required', async () => {
    let caught: unknown;
    try {
      await createCommand(
        {
          noun: 'projects',
          verb: 'create',
          positional: [],
          flags: { app: 'condash', kind: 'project', slug: 'x', title: 't' },
        },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/Unknown flag: --app \(did you mean --apps\?\)/);
    expect((caught as Error).message).not.toMatch(/--apps is required/);
  });

  it('reports unknown flag without a suggestion when nothing is close', async () => {
    let caught: unknown;
    try {
      await createCommand(
        {
          noun: 'projects',
          verb: 'create',
          positional: [],
          flags: { xyzzy: 'foo', apps: 'a', kind: 'project', slug: 'x', title: 't' },
        },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/Unknown flag: --xyzzy$/);
  });

  it('typo wins over missing-required (no --apps, no --kind, plus a typo)', async () => {
    let caught: unknown;
    try {
      await createCommand(
        { noun: 'projects', verb: 'create', positional: [], flags: { app: 'condash' } },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/Unknown flag: --app/);
    expect((caught as Error).message).toMatch(/did you mean --apps/);
  });
});

describe('B3 — --status on create', () => {
  it('writes `status: review` to README when --status review is passed', async () => {
    await createCommand(
      {
        noun: 'projects',
        verb: 'create',
        positional: [],
        flags: {
          apps: 'condash',
          kind: 'project',
          slug: 'b3-review-test',
          title: 'B3 review',
          status: 'review',
        },
      },
      ctx(),
      conceptionPath,
    );
    // createCommand wrote under projects/<YYYY-MM>/<YYYY-MM-DD>-b3-review-test/
    const months = await fs.readdir(join(conceptionPath, 'projects'));
    const month = months.find((m) => /^\d{4}-\d{2}$/.test(m));
    expect(month).toBeDefined();
    const dir = (await fs.readdir(join(conceptionPath, 'projects', month!))).find((d) =>
      d.endsWith('-b3-review-test'),
    );
    expect(dir).toBeDefined();
    const readme = await fs.readFile(
      join(conceptionPath, 'projects', month!, dir!, 'README.md'),
      'utf8',
    );
    expect(readme).toMatch(/status: review/);
  });

  it('defaults to `status: now` when --status is omitted', async () => {
    await createCommand(
      {
        noun: 'projects',
        verb: 'create',
        positional: [],
        flags: {
          apps: 'condash',
          kind: 'project',
          slug: 'b3-default-test',
          title: 'B3 default',
        },
      },
      ctx(),
      conceptionPath,
    );
    const months = await fs.readdir(join(conceptionPath, 'projects'));
    const month = months.find((m) => /^\d{4}-\d{2}$/.test(m))!;
    const dir = (await fs.readdir(join(conceptionPath, 'projects', month))).find((d) =>
      d.endsWith('-b3-default-test'),
    )!;
    const readme = await fs.readFile(
      join(conceptionPath, 'projects', month, dir, 'README.md'),
      'utf8',
    );
    expect(readme).toMatch(/status: now/);
  });

  it('rejects --status done with a pointer to `condash projects close`', async () => {
    let caught: unknown;
    try {
      await createCommand(
        {
          noun: 'projects',
          verb: 'create',
          positional: [],
          flags: {
            apps: 'condash',
            kind: 'project',
            slug: 'b3-done-test',
            title: 'B3 done',
            status: 'done',
          },
        },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(3);
    expect((caught as Error).message).toMatch(/--status done is not allowed at create time/);
    expect((caught as Error).message).toMatch(/condash projects close/);
  });

  it('rejects --status invalid with the standard enum-error shape', async () => {
    let caught: unknown;
    try {
      await createCommand(
        {
          noun: 'projects',
          verb: 'create',
          positional: [],
          flags: {
            apps: 'condash',
            kind: 'project',
            slug: 'b3-invalid-test',
            title: 'B3 invalid',
            status: 'banana',
          },
        },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toMatch(/--status must be one of/);
    expect((caught as Error).message).toMatch(/banana/);
  });
});

describe('--parent on create', () => {
  async function readCreatedReadme(slugTail: string): Promise<string> {
    const months = await fs.readdir(join(conceptionPath, 'projects'));
    const month = months.find((m) => /^\d{4}-\d{2}$/.test(m))!;
    const dir = (await fs.readdir(join(conceptionPath, 'projects', month))).find((d) =>
      d.endsWith(`-${slugTail}`),
    )!;
    return fs.readFile(join(conceptionPath, 'projects', month, dir, 'README.md'), 'utf8');
  }

  it('resolves --parent to the parent’s canonical dated slug and writes it', async () => {
    await createCommand(
      {
        noun: 'projects',
        verb: 'create',
        positional: [],
        flags: { apps: 'condash', kind: 'project', slug: 'checkout-revamp', title: 'Checkout' },
      },
      ctx(),
      conceptionPath,
    );
    await createCommand(
      {
        noun: 'projects',
        verb: 'create',
        positional: [],
        // Short parent slug — createCommand must resolve it to the dated form.
        flags: {
          apps: 'condash',
          kind: 'project',
          slug: 'cart',
          title: 'Cart',
          parent: 'checkout-revamp',
        },
      },
      ctx(),
      conceptionPath,
    );
    const childReadme = await readCreatedReadme('cart');
    expect(childReadme).toMatch(/parent: \d{4}-\d{2}-\d{2}-checkout-revamp/);
  });

  it('rejects --parent that does not resolve to an existing item', async () => {
    let caught: unknown;
    try {
      await createCommand(
        {
          noun: 'projects',
          verb: 'create',
          positional: [],
          flags: {
            apps: 'condash',
            kind: 'project',
            slug: 'orphan',
            title: 'Orphan',
            parent: 'no-such-plan',
          },
        },
        ctx(),
        conceptionPath,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    // resolveSlug throws NOT_FOUND (exit 4) for an unresolvable parent.
    expect((caught as CliError).exitCode).toBe(4);
  });
});
