/** `logs` noun — navigate the per-conception terminal-session logs.
 *
 *  Read-only surface over `<conception>/.condash/logs/`:
 *
 *    days   enumerate days that hold sessions
 *    list   list session metadata, filtered by date / mtime / repo / state
 *    read   output a session's transcript (whole, head/tail, range, or cursor)
 *    tail   last N lines of the active terminal tabs (the "what's live" glance)
 *
 *  Deletion stays a GUI affordance — the CLI never mutates logs. */
import {
  AmbiguousSidError,
  listDays,
  listSessions,
  parseWhen,
  readSession,
  resolveSession,
  type DayRow,
  type ReadOptions,
  type ReadResult,
  type SessionRow,
} from '../../main/logs-query';
import { ambiguous, CliError, emit, ExitCodes, notFound, type OutputContext } from '../output';
import { assertNoExtraFlags, parseCsvFlag, type ParsedArgs } from '../parser';
import { UNIVERSAL_FOOTER } from '../help';

const DAYS_FLAGS = ['month', 'year'] as const;
const LIST_FLAGS = ['since', 'until', 'modified-since', 'repo', 'sid', 'limit', 'active'] as const;
const READ_FLAGS = ['head', 'tail', 'lines', 'from-byte', 'meta', 'with-meta'] as const;
const TAIL_FLAGS = ['sid', 'repo', 'lines', 'all'] as const;
const NOUN_FLAGS: readonly string[] = [
  ...new Set([...DAYS_FLAGS, ...LIST_FLAGS, ...READ_FLAGS, ...TAIL_FLAGS]),
];

export async function runLogs(
  verb: string | null,
  args: ParsedArgs,
  ctx: OutputContext,
  conceptionPath: string,
  universalHelp = false,
): Promise<void> {
  if (verb === 'help') {
    printHelp(args.positional[0] ?? null);
    return;
  }
  if (universalHelp) {
    printHelp(verb);
    return;
  }

  switch (verb) {
    case null:
    case 'days':
      return runDays(args, ctx, conceptionPath);
    case 'list':
      return runList(args, ctx, conceptionPath);
    case 'read':
      return runRead(args, ctx, conceptionPath);
    case 'tail':
      return runTail(args, ctx, conceptionPath);
    default:
      throw new CliError(ExitCodes.USAGE, `Unknown logs verb: ${verb}`);
  }
}

async function runDays(args: ParsedArgs, ctx: OutputContext, conception: string): Promise<void> {
  const month = takeString(args, 'month');
  const year = takeString(args, 'year');
  assertNoExtraFlags(args, NOUN_FLAGS);
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    throw new CliError(ExitCodes.USAGE, `--month must be YYYY-MM (got '${month}')`);
  }
  if (year && !/^\d{4}$/.test(year)) {
    throw new CliError(ExitCodes.USAGE, `--year must be YYYY (got '${year}')`);
  }
  const prefix = month ?? year ?? undefined;
  const days = await listDays(conception, prefix);
  emit(
    ctx,
    { days },
    (d) => {
      const rows = (d as { days: DayRow[] }).days;
      if (rows.length === 0) return 'no session logs found\n';
      return (
        rows
          .map(
            (r) => `${r.day}   ${String(r.sessions).padStart(3)} sessions   ${fmtBytes(r.bytes)}`,
          )
          .join('\n') + '\n'
      );
    },
    [],
    { streamField: 'days' },
  );
}

async function runList(args: ParsedArgs, ctx: OutputContext, conception: string): Promise<void> {
  const day = args.positional[0];
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new CliError(ExitCodes.USAGE, `logs list: <day> must be YYYY-MM-DD (got '${day}')`);
  }
  const now = Date.now();
  const sinceMs = takeWhen(args, 'since', now);
  const untilMs = takeWhen(args, 'until', now);
  const modifiedSinceMs = takeWhen(args, 'modified-since', now);
  const repo = takeString(args, 'repo');
  const sid = takeString(args, 'sid');
  const limit = takeInt(args, 'limit');
  const active = args.flags.active === true;
  delete args.flags.active;
  assertNoExtraFlags(args, NOUN_FLAGS);

  const sessions = await listSessions(conception, {
    day,
    sinceMs,
    untilMs,
    modifiedSinceMs,
    repo: repo ?? undefined,
    sid: sid ?? undefined,
    limit: limit ?? undefined,
    active,
  });
  emit(
    ctx,
    { sessions },
    (d) => {
      const rows = (d as { sessions: SessionRow[] }).sessions;
      if (rows.length === 0) return 'no sessions match\n';
      return rows.map(formatListRow).join('\n') + '\n';
    },
    [],
    { streamField: 'sessions' },
  );
}

async function runRead(args: ParsedArgs, ctx: OutputContext, conception: string): Promise<void> {
  const selector = args.positional[0];
  const head = takeInt(args, 'head');
  const tail = takeInt(args, 'tail');
  const fromByte = takeInt(args, 'from-byte', true);
  const linesSpec = takeString(args, 'lines');
  const metaOnly = args.flags.meta === true;
  delete args.flags.meta;
  const withMeta = args.flags['with-meta'] === true;
  delete args.flags['with-meta'];
  assertNoExtraFlags(args, NOUN_FLAGS);

  if (!selector) {
    throw new CliError(ExitCodes.USAGE, 'Usage: condash logs read <sid|day/sid|path> [options]');
  }
  const lines = linesSpec ? parseLineRange(linesSpec) : undefined;
  const selectors = [
    head !== null,
    tail !== null,
    lines !== undefined,
    fromByte !== null,
    metaOnly,
  ].filter(Boolean).length;
  if (selectors > 1) {
    throw new CliError(
      ExitCodes.USAGE,
      'logs read: --head / --tail / --lines / --from-byte / --meta are mutually exclusive',
    );
  }

  let ref;
  try {
    ref = await resolveSession(conception, selector);
  } catch (err) {
    if (err instanceof AmbiguousSidError) {
      ambiguous(
        err.message,
        err.candidates.map((c) => `${c.day}/${c.sid}`),
      );
    }
    throw err;
  }
  if (!ref) notFound(`No session matches '${selector}'`, { selector });

  const opts: ReadOptions = {
    head: head ?? undefined,
    tail: tail ?? undefined,
    lines,
    fromByte: fromByte ?? undefined,
    metaOnly,
    withMeta,
  };
  const result = await readSession(ref, opts);
  emit(ctx, toReadData(result), (d) => formatRead(d as ReadData, metaOnly));
}

async function runTail(args: ParsedArgs, ctx: OutputContext, conception: string): Promise<void> {
  const sidList = parseCsvFlag(takeString(args, 'sid') ?? undefined);
  const repo = takeString(args, 'repo');
  const n = takeInt(args, 'lines') ?? 20;
  const all = args.flags.all === true;
  delete args.flags.all;
  assertNoExtraFlags(args, NOUN_FLAGS);

  let rows = await listSessions(conception, {
    repo: repo ?? undefined,
    active: !all,
  });
  if (sidList && sidList.length > 0) {
    rows = rows.filter((r) => sidList.some((s) => r.sid === s || r.sid.startsWith(s)));
  }
  interface TailSession {
    sid: string;
    day: string;
    repo?: string;
    cwd?: string;
    active: boolean;
    totalLines: number;
    bytes: number;
    lines: string[];
  }
  const sessions: TailSession[] = [];
  for (const row of rows) {
    const read = await readSession(row, { tail: n });
    sessions.push({
      sid: row.sid,
      day: row.day,
      repo: row.repo,
      cwd: row.cwd,
      active: row.active,
      totalLines: read.totalLines,
      bytes: read.bytes,
      lines: read.text.length === 0 ? [] : read.text.split('\n'),
    });
  }
  emit(
    ctx,
    { sessions },
    (d) => {
      const ss = (d as { sessions: typeof sessions }).sessions;
      if (ss.length === 0) return all ? 'no sessions found\n' : 'no active sessions\n';
      return (
        ss
          .map((s) => {
            const label = [s.sid, s.repo, s.cwd ? `(${s.cwd})` : null].filter(Boolean).join('  ');
            const state = s.active ? 'running' : 'ended';
            const head = `── ${label} ── [${state}, ${s.totalLines} lines]`;
            return [head, ...s.lines].join('\n');
          })
          .join('\n\n') + '\n'
      );
    },
    [],
    { streamField: 'sessions' },
  );
}

interface ReadData {
  sid: string;
  day: string;
  time: string;
  path: string;
  repo?: string;
  cwd?: string;
  header: ReadResult['header'];
  footer: ReadResult['footer'];
  text: string;
  totalLines: number;
  bytes: number;
  fromByte: number | null;
  nextByte: number;
  rotated: boolean;
}

function toReadData(r: ReadResult): ReadData {
  return {
    sid: r.ref.sid,
    day: r.ref.day,
    time: r.ref.time,
    path: r.ref.path,
    repo: typeof r.header?.repo === 'string' ? r.header.repo : undefined,
    cwd: typeof r.header?.cwd === 'string' ? r.header.cwd : undefined,
    header: r.header,
    footer: r.footer,
    text: r.text,
    totalLines: r.totalLines,
    bytes: r.bytes,
    fromByte: r.fromByte,
    nextByte: r.nextByte,
    rotated: r.rotated,
  };
}

function formatRead(d: ReadData, metaOnly: boolean): string {
  if (metaOnly) {
    const lines: string[] = [];
    lines.push(`sid:      ${d.sid}`);
    lines.push(`path:     ${d.path}`);
    if (d.header?.started) lines.push(`started:  ${d.header.started}`);
    if (d.repo) lines.push(`repo:     ${d.repo}`);
    if (d.cwd) lines.push(`cwd:      ${d.cwd}`);
    if (d.header?.cmd) {
      const argv = d.header.argv && d.header.argv.length > 0 ? ' ' + d.header.argv.join(' ') : '';
      lines.push(`cmd:      ${d.header.cmd}${argv}`);
    }
    if (d.footer) {
      lines.push(`finished: ${d.footer.finished ?? '(unknown)'}`);
      lines.push(`exitCode: ${d.footer.exitCode ?? '(unknown)'}`);
    } else {
      lines.push(`exitCode: (running)`);
    }
    lines.push(`bytes:    ${d.bytes}`);
    lines.push(`lines:    ${d.totalLines}`);
    return lines.join('\n') + '\n';
  }
  if (d.rotated) {
    return `(rotated: cursor ${d.fromByte} is past current size ${d.bytes} — file trimmed)\n`;
  }
  return d.text.length === 0 ? '' : d.text + '\n';
}

function formatListRow(r: SessionRow): string {
  const state = r.active ? 'running' : r.exitCode === null ? 'ended(?)' : `exit ${r.exitCode}`;
  const repo = (r.repo ?? '-').padEnd(12);
  const cmd = r.cmd ? `  ${r.cmd}` : '';
  return `${r.day} ${r.time}  ${r.sid.padEnd(12)} ${repo} ${state.padEnd(9)} ${fmtBytes(r.bytes).padStart(9)}${cmd}`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse `a-b` / `a-` / `a` into an inclusive 1-based range. */
function parseLineRange(spec: string): { from: number; to: number | null } {
  const m = /^(\d+)(?:-(\d+)?)?$/.exec(spec.trim());
  if (!m) {
    throw new CliError(ExitCodes.USAGE, `--lines must be 'A-B', 'A-', or 'A' (got '${spec}')`);
  }
  const from = Number.parseInt(m[1], 10);
  // `A` alone → single line; `A-` → to end; `A-B` → through B.
  const hasDash = spec.includes('-');
  const to = m[2] !== undefined ? Number.parseInt(m[2], 10) : hasDash ? null : from;
  if (to !== null && to < from) {
    throw new CliError(ExitCodes.USAGE, `--lines: end (${to}) precedes start (${from})`);
  }
  return { from, to };
}

/** Pull a string-valued flag and delete it from the bag. */
function takeString(args: ParsedArgs, name: string): string | null {
  const v = args.flags[name];
  if (v === undefined) return null;
  if (typeof v !== 'string') {
    throw new CliError(ExitCodes.USAGE, `--${name} expects a value`);
  }
  delete args.flags[name];
  return v;
}

/** Pull an integer-valued flag and delete it. `allowZero` permits 0 (used by
 *  --from-byte, where offset 0 is a legitimate "from the start" cursor). */
function takeInt(args: ParsedArgs, name: string, allowZero = false): number | null {
  const v = args.flags[name];
  if (v === undefined) return null;
  if (typeof v !== 'string') {
    throw new CliError(ExitCodes.USAGE, `--${name} expects a number`);
  }
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new CliError(
      ExitCodes.USAGE,
      `--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer (got '${v}')`,
    );
  }
  delete args.flags[name];
  return n;
}

/** Pull a `<when>` flag, parse it, and delete it. Returns undefined when absent. */
function takeWhen(args: ParsedArgs, name: string, nowMs: number): number | undefined {
  const v = takeString(args, name);
  if (v === null) return undefined;
  const ms = parseWhen(v, nowMs);
  if (ms === null) {
    throw new CliError(
      ExitCodes.USAGE,
      `--${name}: expected a date (YYYY-MM-DD[THH:MM]), span (30m/2h/3d/1w), or today/yesterday (got '${v}')`,
    );
  }
  return ms;
}

function printHelp(verb: string | null): void {
  switch (verb) {
    case 'days':
      out([
        'condash logs days [--month YYYY-MM] [--year YYYY]',
        '',
        'List days that contain session logs (newest first), with session count and size.',
        '',
        'Examples:',
        '  condash logs days',
        '  condash logs days --month 2026-05 --json',
      ]);
      return;
    case 'list':
      out([
        'condash logs list [<day>] [filters]',
        '',
        'List session logs, newest spawn-time first. <day> is YYYY-MM-DD.',
        '',
        'Filters:',
        '  --since <when>           keep sessions spawned at/after <when>',
        '  --until <when>           keep sessions spawned at/before <when>',
        '  --modified-since <when>  keep sessions whose file changed at/after <when>',
        '  --repo <name>            match the spawn repo',
        '  --active                 only sessions still running (no footer)',
        '  --sid <prefix>           match a session-id prefix',
        '  --limit <n>              cap the row count',
        '',
        '<when>: YYYY-MM-DD[THH:MM], a span (30m/2h/3d/1w), or today/yesterday.',
        '',
        'Examples:',
        '  condash logs list --since today',
        '  condash logs list 2026-05-30 --repo condash',
        '  condash logs list --modified-since 2h --active',
      ]);
      return;
    case 'read':
      out([
        'condash logs read <sid|day/sid|path> [selector]',
        '',
        "Output a session's transcript. Meta lines are stripped unless --with-meta.",
        '',
        'Selectors (mutually exclusive):',
        '  --head <n>        first n lines',
        '  --tail <n>        last n lines',
        '  --lines <a-b>     inclusive 1-based range (also A- or A)',
        '  --from-byte <n>   raw bytes from offset n to EOF (the stateless cursor)',
        '  --meta            only the parsed header/footer, no body',
        '  --with-meta       keep the # condash: meta lines in the body',
        '',
        'Examples:',
        '  condash logs read t-a1b2c3d4',
        '  condash logs read t-a1b2 --tail 40',
        '  condash logs read t-a1b2 --from-byte 31044 --json   # what changed since',
      ]);
      return;
    case 'tail':
      out([
        'condash logs tail [--sid s,s] [--repo name] [--lines n] [--all]',
        '',
        'Last n lines (default 20) of the active terminal tabs — a live glance.',
        'Default set is active sessions (no footer); --all includes ended ones.',
        '',
        'Examples:',
        '  condash logs tail',
        '  condash logs tail --lines 10 --repo condash',
        '  condash logs tail --all --json',
      ]);
      return;
    default:
      out([
        'condash logs <verb> [args]',
        '',
        'Verbs:',
        '  days    List days that hold session logs.',
        '  list    List sessions, filtered by date / mtime / repo / state.',
        '  read    Output a session transcript (whole, head/tail, range, cursor).',
        '  tail    Last lines of the active terminal tabs.',
        '',
        'Read-only: the CLI never deletes logs (that stays a GUI affordance).',
      ]);
  }
}

function out(body: string[]): void {
  process.stdout.write([...body, '', UNIVERSAL_FOOTER, ''].join('\n'));
}
