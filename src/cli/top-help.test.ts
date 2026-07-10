/**
 * TOP_HELP drift guard.
 *
 * The top-level help hand-writes each noun's verb list (generating it is
 * awkward — the verb maps are inline closures per runner). This test derives
 * each noun's actual verbs from its own overview help (the `Verbs:` block the
 * runner prints) and asserts TOP_HELP mentions every one, so a new verb that
 * lands without a TOP_HELP update fails here instead of silently hiding.
 * The `audit` noun is verbless; its line is checked against the exported
 * ALL_AUDIT_CHECKS instead.
 */
import { describe, expect, it } from 'vitest';
import { TOP_HELP } from './help';
import { humanCtx, captureStdout } from './commands/test-helpers';
import type { ParsedArgs } from './parser';
import { runProjects } from './commands/projects';
import { runKnowledge } from './commands/knowledge';
import { runRepos } from './commands/repos';
import { runApplications } from './commands/applications';
import { runWorktrees } from './commands/worktrees';
import { runDirty } from './commands/dirty';
import { runLogs } from './commands/logs';
import { runSync } from './commands/sync';
import { runSkills } from './commands/skills';
import { runConfig } from './commands/config';
import { ALL_AUDIT_CHECKS } from './commands/audit';

function emptyArgs(noun: string): ParsedArgs {
  return { noun, verb: null, positional: [], flags: {} };
}

/** Parse TOP_HELP's `Nouns:` block into noun -> joined description text. */
function topHelpNounBlocks(): Map<string, string> {
  const lines = TOP_HELP.split('\n');
  const start = lines.findIndex((line) => line === 'Nouns:');
  expect(start).toBeGreaterThan(-1);
  const blocks = new Map<string, string>();
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

// Every printHelp prints the noun overview (the `Verbs:` block) on either
// a null verb (projects, knowledge, applications, worktrees, logs) or its
// default/unknown-verb case (repos, dirty, skills, config — which map null
// to their primary verb's help). Both paths short-circuit via universalHelp
// before any verb validation, so probe each and keep the one that carries
// the `Verbs:` block.
const OVERVIEW_SENTINEL = '__overview__';

const NOUN_RUNNERS: Record<string, (verb: string | null) => Promise<void> | void> = {
  projects: (v) => runProjects(v, emptyArgs('projects'), humanCtx(), '', true),
  knowledge: (v) => runKnowledge(v, emptyArgs('knowledge'), humanCtx(), '', true),
  repos: (v) => runRepos(v, emptyArgs('repos'), humanCtx(), '', true),
  applications: (v) => runApplications(v, emptyArgs('applications'), humanCtx(), '', true),
  worktrees: (v) => runWorktrees(v, emptyArgs('worktrees'), humanCtx(), '', true),
  dirty: (v) => runDirty(v, emptyArgs('dirty'), humanCtx(), '', true),
  logs: (v) => runLogs(v, emptyArgs('logs'), humanCtx(), '', true),
  sync: (v) => runSync(v, emptyArgs('sync'), humanCtx(), '', true),
  skills: (v) => runSkills(v, emptyArgs('skills'), humanCtx(), true),
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

describe('TOP_HELP verb lists', () => {
  const blocks = topHelpNounBlocks();

  for (const [noun, runOverview] of Object.entries(NOUN_RUNNERS)) {
    it(`mentions every ${noun} verb`, async () => {
      const stdout = await captureOverview(runOverview);
      const verbs = verbsFromOverview(stdout);
      const text = blocks.get(noun);
      expect(text, `TOP_HELP should carry a '${noun}' noun line`).toBeTruthy();
      for (const verb of verbs) {
        expect(text, `TOP_HELP '${noun}' line should mention verb '${verb}'`).toContain(verb);
      }
    });
  }

  it('mentions every audit check on the audit line', () => {
    const text = blocks.get('audit');
    expect(text, `TOP_HELP should carry an 'audit' noun line`).toBeTruthy();
    for (const check of ALL_AUDIT_CHECKS) {
      expect(text, `TOP_HELP 'audit' line should mention check '${check}'`).toContain(check);
    }
  });
});
