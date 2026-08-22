/**
 * Docs-drift guard: the docs site's CLI pages must keep up with the CLI's
 * noun/verb surface.
 *
 * `docs/reference/cli.md` is the canonical CLI reference, but nothing in CI
 * used to read it — a new noun or verb could land in the CLI and stay
 * undocumented forever. This test derives each noun's actual verbs from the
 * CLI itself (the `Verbs:` block of its overview help, the same mechanism
 * `src/cli/top-help.test.ts` uses) and asserts `reference/cli.md` documents
 * them. It also pins the in-app `docs/help/cli.md` to never mention the
 * removed `plans` alias. Assertions search for tokens, not whole lines, so
 * prose rewrites don't trip them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOP_HELP } from '../src/cli/help';
import { humanCtx, captureStdout } from '../src/cli/commands/test-helpers';
import type { ParsedArgs } from '../src/cli/parser';
import { runProjects } from '../src/cli/commands/projects';
import { runKnowledge } from '../src/cli/commands/knowledge';
import { runRepos } from '../src/cli/commands/repos';
import { runApplications } from '../src/cli/commands/applications';
import { runWorktrees } from '../src/cli/commands/worktrees';
import { runDirty } from '../src/cli/commands/dirty';
import { runLogs } from '../src/cli/commands/logs';
import { runSync } from '../src/cli/commands/sync';
import { runSkills } from '../src/cli/commands/skills';
import { runConfig } from '../src/cli/commands/config';
import { runMdx } from '../src/cli/commands/mdx';
import { ALL_AUDIT_CHECKS } from '../src/cli/commands/audit';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

function readDoc(relPath: string): string {
  return readFileSync(join(DOCS_DIR, relPath), 'utf8');
}

function emptyArgs(noun: string): ParsedArgs {
  return { noun, verb: null, positional: [], flags: {} };
}

/**
 * Parse TOP_HELP's noun blocks into noun -> joined description text. The
 * surface is tiered into a `Daily:` section and a `Maintenance:` section;
 * both carry noun lines in the same shape, so each is parsed so a
 * Maintenance noun (e.g. `dirty`) cannot hide from the drift check.
 */
function topHelpNounBlocks(): Map<string, string> {
  const lines = TOP_HELP.split('\n');
  const blocks = new Map<string, string>();
  for (const header of ['Daily:', 'Maintenance:']) {
    const start = lines.findIndex((line) => line === header);
    expect(start, `TOP_HELP should carry a '${header}' section`).toBeGreaterThan(-1);
    let current: string | null = null;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') break;
      const head = /^ {2}(\S+) +(\S.*)$/.exec(line);
      if (head) {
        current = head[1];
        blocks.set(current, head[2]);
      } else if (current) {
        // Continuation line (deeper indent) — join onto the noun's text.
        blocks.set(current, `${blocks.get(current)} ${line.trim()}`);
      }
    }
  }
  return blocks;
}

/** Extract the verb tokens from a noun's overview help (`Verbs:` block). */
function verbsFromOverview(helpText: string): string[] {
  const lines = helpText.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Verbs:');
  expect(start, `overview help should carry a Verbs: block:\n${helpText}`).toBeGreaterThan(-1);
  const verbs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}(\S+)/.exec(lines[i]);
    if (!m) break;
    verbs.push(m[1]);
  }
  expect(verbs.length).toBeGreaterThan(0);
  return verbs;
}

// The same overview-help probes as src/cli/top-help.test.ts: each runner
// prints the noun's `Verbs:` block on a null verb or its default-verb case.
const OVERVIEW_SENTINEL = '__overview__';

// Every verbed noun TOP_HELP lists, mirroring NOUN_RUNNERS in
// src/cli/top-help.test.ts: each runner prints the noun's `Verbs:` block on a
// null verb or its default-verb case. The verbless nouns (`search`, `help`)
// and the single-verb `init` have no `Verbs:` block to capture — their docs
// coverage is the noun-section check below; `audit` is verbless and is
// checked against ALL_AUDIT_CHECKS like top-help.test.ts does.
const SAMPLE_NOUNS: Record<string, (verb: string | null) => Promise<void> | void> = {
  projects: (v) => runProjects(v, emptyArgs('projects'), humanCtx(), '', true),
  knowledge: (v) => runKnowledge(v, emptyArgs('knowledge'), humanCtx(), '', true),
  repos: (v) => runRepos(v, emptyArgs('repos'), humanCtx(), '', true),
  applications: (v) => runApplications(v, emptyArgs('applications'), humanCtx(), '', true),
  worktrees: (v) => runWorktrees(v, emptyArgs('worktrees'), humanCtx(), '', true),
  dirty: (v) => runDirty(v, emptyArgs('dirty'), humanCtx(), '', true),
  logs: (v) => runLogs(v, emptyArgs('logs'), humanCtx(), '', true),
  sync: (v) => runSync(v, emptyArgs('sync'), humanCtx(), '', true),
  skills: (v) => runSkills(v, emptyArgs('skills'), humanCtx(), true),
  mdx: (v) => runMdx(v, emptyArgs('mdx'), humanCtx(), '', true),
  config: (v) => runConfig(v, emptyArgs('config'), humanCtx(), '', true),
};

/** Capture the noun's overview help, whichever verb argument produces it. */
async function captureOverview(
  runOverview: (verb: string | null) => Promise<void> | void,
): Promise<string> {
  for (const probe of [null, OVERVIEW_SENTINEL]) {
    const { stdout, threw } = await captureStdout(() => runOverview(probe));
    expect(threw).toBeUndefined();
    if (stdout.includes('Verbs:')) return stdout;
  }
  throw new Error('no probe produced an overview help with a Verbs: block');
}

/** The body of the `### `noun`` section in reference/cli.md. */
function referenceSection(reference: string, noun: string): string {
  const lines = reference.split('\n');
  const start = lines.findIndex((line) => line === `### \`${noun}\``);
  expect(start, `reference/cli.md should carry a '### \`${noun}\`' section`).toBeGreaterThan(-1);
  const next = lines.findIndex((line, i) => i > start && /^### /.test(line));
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n');
}

describe('docs/reference/cli.md keeps up with the CLI surface', () => {
  const reference = readDoc('reference/cli.md');

  it('documents every noun TOP_HELP lists', () => {
    const nouns = topHelpNounBlocks();
    expect(nouns.size).toBeGreaterThan(0);
    for (const noun of nouns.keys()) {
      expect(reference, `reference/cli.md should carry a '### \`${noun}\`' section`).toContain(
        `### \`${noun}\``,
      );
    }
  });

  it('documents every audit check on the audit section', () => {
    const section = referenceSection(reference, 'audit');
    for (const check of ALL_AUDIT_CHECKS) {
      expect(section, `reference/cli.md 'audit' section should mention check '${check}'`).toContain(
        check,
      );
    }
  });

  for (const [noun, runOverview] of Object.entries(SAMPLE_NOUNS)) {
    it(`documents every ${noun} verb`, async () => {
      const stdout = await captureOverview(runOverview);
      const verbs = verbsFromOverview(stdout);
      const section = referenceSection(reference, noun);
      for (const verb of verbs) {
        expect(
          section,
          `reference/cli.md '${noun}' section should mention verb '${verb}'`,
        ).toContain(verb);
      }
    });
  }
});

describe('docs/help/cli.md never mentions the removed plans alias', () => {
  it('the alias is gone from the in-app CLI help', () => {
    const body = readDoc('help/cli.md');
    const mentions = body.split('\n').filter((line) => line.includes('plans'));
    expect(mentions, `docs/help/cli.md must not mention the removed 'plans' alias`).toEqual([]);
  });
});
