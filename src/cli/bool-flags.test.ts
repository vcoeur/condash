/**
 * Guard against the BOOL_FLAGS-registry drift class.
 *
 * The parser keeps a manual registry of boolean long flags (`BOOL_FLAGS` in
 * parser.ts). A switch a command reads as boolean but missing from that set is
 * parsed as `--name <value>` and fails at argv time with "expects a value" —
 * `--record` shipped broken that way for ~10 days because command tests inject
 * pre-parsed flag bags and never exercise the real parser.
 *
 * Two layers:
 *  1. A static scan of every command source for boolean-flag usage patterns
 *     (`takeBoolFlag(args, '<name>')`, `flags.<name> === true`,
 *     `flags['<name>'] === true`) asserting each discovered name is in
 *     BOOL_FLAGS.
 *  2. Argv-level smoke tests: one representative argv per noun, run through
 *     the REAL `parseArgs`, asserting the boolean flag lands as `true`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOL_FLAGS, parseArgs, takeUniversalFlags } from './parser';
import { runLogs } from './commands/logs';
import {
  captureStdout,
  jsonCtx,
  makeTmpConception,
  parseJsonEnvelope,
  rmConception,
} from './commands/test-helpers';

const COMMANDS_DIR = join(__dirname, 'commands');

/** Collect every boolean-flag name referenced by the command sources. */
function scanBoolFlagUsages(): Map<string, string[]> {
  const found = new Map<string, string[]>(); // name -> files using it
  const files = readdirSync(COMMANDS_DIR).filter(
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
  );
  const patterns = [
    /takeBoolFlag\(\s*[\w.]+\s*,\s*'([^']+)'\s*\)/g,
    /\bflags\.([A-Za-z_$][\w$]*)\s*===\s*true/g,
    /\bflags\[\s*'([^']+)'\s*\]\s*===\s*true/g,
  ];
  for (const file of files) {
    const src = readFileSync(join(COMMANDS_DIR, file), 'utf8');
    for (const pattern of patterns) {
      for (const match of src.matchAll(pattern)) {
        const name = match[1];
        const users = found.get(name) ?? [];
        if (!users.includes(file)) users.push(file);
        found.set(name, users);
      }
    }
  }
  return found;
}

describe('BOOL_FLAGS registry', () => {
  it('covers every boolean-flag usage in src/cli/commands/', () => {
    const usages = scanBoolFlagUsages();
    // Sanity: the scan must actually find usages — an empty result means the
    // patterns rotted, not that the registry is complete.
    expect(usages.size).toBeGreaterThan(5);
    const missing = [...usages.entries()]
      .filter(([name]) => !BOOL_FLAGS.has(name))
      .map(([name, files]) => `--${name} (used in ${files.join(', ')})`);
    expect(missing, `flags read as boolean but missing from BOOL_FLAGS`).toEqual([]);
  });
});

describe('argv-level boolean-flag smoke tests (real parseArgs per noun)', () => {
  const cases: { argv: string[]; boolFlags: string[] }[] = [
    { argv: ['projects', 'read', 'my-slug', '--with-notes'], boolFlags: ['with-notes'] },
    {
      argv: ['projects', 'check-knowledge', 'my-slug', '--record'],
      boolFlags: ['record'], // the regression that motivated this suite
    },
    {
      argv: ['projects', 'close', 'my-slug', '--no-touch-dirty', '--summary', 'done'],
      boolFlags: ['no-touch-dirty'],
    },
    {
      argv: ['knowledge', 'index', '--dry-run', '--rewrite-aggregated'],
      boolFlags: ['dry-run', 'rewrite-aggregated'],
    },
    { argv: ['search', 'query', '--json'], boolFlags: ['json'] },
    { argv: ['repos', 'list', '--include-worktrees'], boolFlags: ['include-worktrees'] },
    { argv: ['applications', 'validate', '--fix'], boolFlags: ['fix'] },
    {
      argv: ['worktrees', 'setup', 'branch-x', '--copy-env', '--no-install'],
      boolFlags: ['copy-env', 'no-install'],
    },
    {
      argv: ['worktrees', 'remove', 'branch-x', '--force', '--force-rm'],
      boolFlags: ['force', 'force-rm'],
    },
    { argv: ['audit', '--include', 'lfs', '--json'], boolFlags: ['json'] },
    { argv: ['dirty', 'list', '--ndjson'], boolFlags: ['ndjson'] },
    { argv: ['logs', 'list', '--active', '--repo', 'condash'], boolFlags: ['active'] },
    { argv: ['logs', 'read', 't-abc', '--meta', '--redact'], boolFlags: ['meta', 'redact'] },
    { argv: ['logs', 'tail', '--all'], boolFlags: ['all'] },
    {
      argv: ['skills', 'install', '--dry-run', '--force', '--diff', '--prune'],
      boolFlags: ['dry-run', 'force', 'diff', 'prune'],
    },
    { argv: ['config', 'list', '--effective'], boolFlags: ['effective'] },
    { argv: ['config', 'set', 'k', 'v', '--global'], boolFlags: ['global'] },
  ];

  for (const { argv, boolFlags } of cases) {
    it(`condash ${argv.join(' ')}`, () => {
      const parsed = parseArgs(argv);
      expect(parsed.noun).toBe(argv[0]);
      for (const flag of boolFlags) {
        expect(parsed.flags[flag], `--${flag} should parse as boolean true`).toBe(true);
      }
    });
  }

  it('round-trips real argv through dispatch (logs list --active)', async () => {
    // The class of bug this suite guards against only bites when the REAL
    // parser feeds a command — command tests inject pre-parsed bags. Wire
    // one cheap end-to-end path: argv → parseArgs → takeUniversalFlags →
    // runLogs against an empty conception.
    const conception = await makeTmpConception();
    try {
      const parsed = parseArgs(['logs', 'list', '--active', '--json']);
      takeUniversalFlags(parsed);
      const { stdout, threw } = await captureStdout(() =>
        runLogs(parsed.verb, parsed, jsonCtx(), conception),
      );
      expect(threw).toBeUndefined();
      expect(parseJsonEnvelope(stdout).ok).toBe(true);
    } finally {
      await rmConception(conception);
    }
  });
});
