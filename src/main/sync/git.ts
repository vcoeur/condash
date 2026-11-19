/**
 * Git plumbing for `condash sync`.
 *
 * Everything here runs against the conception checkout itself (not a repo
 * worktree), under the sync lock. Reads use porcelain; writes use the normal
 * index. Recovery attribute proofs alone use private pinned indexes; those
 * indexes never stage, commit, or restore the live index.
 */
import { constants, promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { exec } from '../exec';

/** `git add` argv is chunked so a very large sweep can't hit ARG_MAX. */
const ADD_CHUNK = 100;

export interface ChangedPath {
  /** Repo-relative, POSIX separators. */
  path: string;
  conflicted: boolean;
  /** The path has no blob in HEAD — untracked, or added but never committed.
   *  An index bullet pointing at such a path would dangle on `main`, which is
   *  what the sweeper's index deferral exists to prevent. */
  newToHead: boolean;
  /** The path is deleted in the worktree (or staged for deletion) while HEAD
   *  still holds its blob. With `--no-renames` this is the old side of a
   *  move: paired with the matching `newToHead` paths, it is what lets the
   *  sweeper commit a rename as one unit (see `detectRenamePairs`). */
  deleted: boolean;
}

/** Error carrying git's own stderr, so callers can pattern-match on it. */
interface ExecError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

/**
 * Absolute git dir for `cwd`. Not `join(root, '.git')`: in a linked worktree
 * `.git` is a *file* pointing elsewhere, and the lock must live in the real dir.
 *
 * @param cwd any path inside the repo
 */
export async function resolveGitDir(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd });
  return stdout.trim();
}

/**
 * Name the in-progress git operation blocking a sync, or `null` when the tree
 * is operable. Committing during a merge or rebase would either abort the
 * operation or record a half-resolved tree.
 *
 * @param gitDir absolute git dir
 */
export async function inProgressOperation(gitDir: string): Promise<string | null> {
  const probes: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
  ];
  for (const [entry, label] of probes) {
    if (await exists(join(gitDir, entry))) return label;
  }
  return null;
}

/**
 * Every path git considers changed, including untracked files.
 *
 * `--no-renames` collapses a rename into a delete plus an untracked add, which
 * removes the paired-record parse from `-z` porcelain output. `-uall` lists
 * untracked *files* rather than their parent directory, so per-file mtime
 * filtering works. Gitignored paths never appear.
 *
 * @param cwd conception root
 */
export async function readChangedPaths(cwd: string): Promise<ChangedPath[]> {
  const { stdout } = await exec(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd },
  );
  const out: ChangedPath[] = [];
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    out.push({
      path: entry.slice(3),
      conflicted: isConflict(x, y),
      newToHead: isNewToHead(x),
      deleted: isDeleted(x, y),
    });
  }
  return out;
}

/** Porcelain v1 index-column codes for a path HEAD has never held: `?` is
 *  untracked, `A` is staged as an addition. Anything else (`M`, `D`, ` `,
 *  `R`, …) names a path that already has a committed blob. */
function isNewToHead(x: string): boolean {
  return x === '?' || x === 'A';
}

/** Porcelain v1 conflict codes: either side unmerged, or both-added/both-deleted. */
function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

/** Porcelain v1 delete codes on either column, excluding conflicts (a DD
 *  both-deleted path is conflict state, not the old side of a move). */
function isDeleted(x: string, y: string): boolean {
  return !isConflict(x, y) && (x === 'D' || y === 'D');
}

/**
 * Stage and commit exactly `paths`, leaving any foreign staged content staged.
 *
 * `git add -A` first because `git commit --only` refuses a pathspec that
 * matches nothing git knows about (i.e. an untracked file). `--only` then
 * commits those paths alone, disregarding whatever else sits in the index —
 * the property that keeps a stray session `git add` out of this commit.
 *
 * @param cwd conception root
 * @param paths repo-relative paths, non-empty
 * @param subject commit subject line
 * @returns the new commit sha, or `null` when git found nothing to record
 */
export async function commitPaths(
  cwd: string,
  paths: readonly string[],
  subject: string,
  recovery?: RecoveryCommitCheckpoints,
): Promise<string | null> {
  if (paths.length === 0) return null;

  for (let i = 0; i < paths.length; i += ADD_CHUNK) {
    const chunk = paths.slice(i, i + ADD_CHUNK);
    await recovery?.beforeAdd(chunk);
    await exec('git', ['add', '-A', '--', ...chunk], { cwd });
    await recovery?.afterAdd(chunk);
  }

  await recovery?.beforeCommit(paths);
  try {
    await exec('git', ['commit', '--only', '--message', subject, '--', ...paths], { cwd });
  } catch (err) {
    // A recovery failure leaves its durable intent unresolved, even if a hook mimics Git's no-op text.
    if (recovery) throw err;
    const combined = `${(err as ExecError).stdout ?? ''}${(err as ExecError).stderr ?? ''}`;
    if (/nothing to commit|no changes added to commit/i.test(combined)) {
      return null;
    }
    throw err;
  }

  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  const sha = stdout.trim();
  await recovery?.afterCommit(paths, sha);
  return sha;
}

/**
 * A file's content as of HEAD.
 *
 * @param cwd conception root
 * @param relPath repo-relative, POSIX-separated path
 * @returns the committed text, or `null` when the path is not in HEAD (a new
 *          file) or the repo has no HEAD yet (no commits)
 */
export async function readFileAtHead(cwd: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:${relPath}`], { cwd });
    return stdout;
  } catch (err) {
    const combined = `${(err as ExecError).stdout ?? ''}${(err as ExecError).stderr ?? ''}`;
    // "does not exist in" / "exists on disk, but not in" — path absent from
    // HEAD (a new file); "invalid object name" — no HEAD yet (empty repo).
    if (/does not exist in|exists on disk|invalid object name/i.test(combined)) return null;
    throw err;
  }
}

/**
 * Commits on HEAD that the upstream branch doesn't have.
 *
 * @param cwd conception root
 * @returns the count, or `null` when the branch has no upstream configured
 */
export async function upstreamAhead(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Commits on the upstream branch that HEAD doesn't have — the mirror of
 * `upstreamAhead`.
 *
 * @param cwd conception root
 * @returns the count, or `null` when the branch has no upstream configured
 */
export async function behindUpstream(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', 'HEAD..@{upstream}'], { cwd });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Push HEAD to its upstream. Never rebases or force-pushes: a rejected push is
 * reported and the commits stay local for the next tick to retry.
 *
 * @param cwd conception root
 */
export async function push(cwd: string): Promise<void> {
  await exec('git', ['push'], { cwd });
}

/**
 * Fetch the default remote. Read-only — never forces or rewrites local refs;
 * updates the remote-tracking refs `behindUpstream` and `ffOnlyMerge` read.
 *
 * @param cwd conception root
 */
export async function fetchUpstream(cwd: string): Promise<void> {
  await exec('git', ['fetch'], { cwd });
}

/**
 * Fast-forward HEAD to its upstream, refusing on divergence or on any local
 * change a remote update would clobber. The caller has already fetched.
 *
 * @param cwd conception root
 * @returns `{ ok: true }` on a fast-forward, or `{ ok: false, error }` with
 *          a bounded multiline diagnostic when the merge is refused
 */
export async function ffOnlyMerge(
  cwd: string,
  pinnedUpstream?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (pinnedUpstream !== undefined) assertRecoveryOid(pinnedUpstream);
    await exec(
      'git',
      pinnedUpstream === undefined
        ? ['merge', '--ff-only']
        : ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', pinnedUpstream],
      { cwd },
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: formatGitDiagnostic(err),
    };
  }
}

/** Bound diagnostics without dropping all the useful path lines after Git's heading. */
export function formatGitDiagnostic(error: unknown): string {
  const detail = error as ExecError | null;
  const text =
    [detail?.stderr, detail?.stdout, detail?.message, typeof error === 'string' ? error : ''].find(
      (source) => typeof source === 'string' && source.trim() !== '',
    ) ?? 'unknown error';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = '\n[diagnostic truncated]';
  let result = lines.slice(0, 12).join('\n');
  if (lines.length > 12 || Buffer.byteLength(result) > 4096) {
    result = lines.slice(0, 11).join('\n');
    const characters: string[] = [];
    let bytes = Buffer.byteLength(marker);
    for (const character of result) {
      bytes += Buffer.byteLength(character);
      if (bytes > 4096) break;
      characters.push(character);
    }
    result = characters.join('') + marker;
  }
  return result;
}

/** Recovery hooks bracket every add chunk and commit, including commit --only's second clean. */
export interface RecoveryCommitCheckpoints {
  beforeAdd(paths: readonly string[]): Promise<void>;
  afterAdd(paths: readonly string[]): Promise<void>;
  beforeCommit(paths: readonly string[]): Promise<void>;
  afterCommit(paths: readonly string[], sha: string | null): Promise<void>;
}

/** Finite bounds apply before reading command output, objects, or dependency files. */
export interface RecoveryGitLimits {
  maxBytes: number;
  maxEntries: number;
}

export interface RecoveryGitChange {
  path: string;
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: 'A' | 'M' | 'D' | 'T';
}

export interface RecoveryDirectoryEntry {
  name: string;
  mode: string;
  oid: string;
  kind: 'directory' | 'file' | 'other';
}

export interface RecoveryStageEntry {
  path: string;
  mode: string;
  oid: string;
  stage: number;
  flag: string;
  flags: string;
}

interface RecoveryConfigEntry {
  scope: string;
  origin: string;
  key: string;
  value: string;
}

export interface RecoveryGitState {
  root: string;
  gitDir: string;
  head: string;
  branch: string;
  upstream: string;
  upstreamOid: string;
  remote: string;
  mergeRef: string;
  pushRef: string;
  pushRemote: string;
  pushMergeRef: string;
  remoteUrls: string[];
  pushUrls: string[];
  config: RecoveryConfigEntry[];
  entries: RecoveryStageEntry[];
  staged: string;
}

export interface RecoveryDependency {
  path: string;
  identity: string | null;
  sha256: string | null;
  size: number;
}

export interface RecoveryAttributeProof {
  head: string;
  incoming: string;
  paths: string[];
  config: RecoveryConfigEntry[];
  dependencies: RecoveryDependency[];
  attributes: {
    epoch: 'head' | 'incoming' | 'current';
    path: string;
    attribute: string;
    value: string;
  }[];
  privateIndexes: string[];
  indexAttributes: string;
  environment: Record<string, string | undefined>;
}

const OUTPUT_ATTRIBUTES = ['text', 'eol', 'filter', 'working-tree-encoding', 'ident', 'crlf'];

function assertRecoveryLimits(limits: RecoveryGitLimits): void {
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries < 1
  ) {
    throw new Error('Recovery Git limits must be finite positive integers');
  }
}

function assertRecoveryOid(oid: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('Invalid pinned Git object ID');
}

function assertRecoveryPath(path: string): void {
  if (
    !path ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid recovery Git path: ${JSON.stringify(path)}`);
  }
}

function assertRecoveryEnvironment(): void {
  for (const key of [
    'GIT_DIR',
    'GIT_COMMON_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_SHALLOW_FILE',
    'GIT_REPLACE_REF_BASE',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_NAMESPACE',
    'GIT_ATTR_SOURCE',
  ]) {
    if (process.env[key] !== undefined)
      throw new Error(`Recovery Git environment redirection: ${key}`);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key) ||
      (['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'].includes(key) && value !== '/dev/null')
    ) {
      throw new Error(`Recovery Git configuration redirection: ${key}`);
    }
  }
}

function recoveryText(bytes: Buffer): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('Non-round-trippable UTF-8 Git metadata');
  return text;
}

async function recoveryGit(
  cwd: string,
  args: string[],
  limits: RecoveryGitLimits,
  options: { index?: string; input?: Buffer } = {},
): Promise<Buffer> {
  assertRecoveryLimits(limits);
  assertRecoveryEnvironment();
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      'git',
      ['--literal-pathspecs', ...args],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: limits.maxBytes,
        timeout: 60_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          ...(options.index ? { GIT_INDEX_FILE: options.index } : {}),
        },
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOutput(stdout);
      },
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(options.input);
  });
}

async function recoveryGitText(
  cwd: string,
  args: string[],
  limits: RecoveryGitLimits,
  options?: { index?: string; input?: Buffer },
): Promise<string> {
  return recoveryText(await recoveryGit(cwd, args, limits, options));
}

function boundedRecords(raw: string, limits: RecoveryGitLimits): string[] {
  if (raw !== '' && !raw.endsWith('\0')) throw new Error('Incomplete NUL-delimited Git response');
  const records: string[] = [];
  let offset = 0;
  while (offset < raw.length) {
    if (records.length >= limits.maxEntries) throw new Error('Recovery Git entry limit exceeded');
    const end = raw.indexOf('\0', offset);
    records.push(raw.slice(offset, end));
    offset = end + 1;
  }
  return records;
}

/** Read immutable H-to-M identities; no rename inference or stderr authorization. */
export async function readRecoveryChanges(
  cwd: string,
  head: string,
  incoming: string,
  limits: RecoveryGitLimits,
): Promise<RecoveryGitChange[]> {
  assertRecoveryOid(head);
  assertRecoveryOid(incoming);
  const raw = await recoveryGitText(
    cwd,
    [
      'diff-tree',
      '--raw',
      '-z',
      '-r',
      '--no-renames',
      '--no-abbrev',
      '--no-commit-id',
      head,
      incoming,
    ],
    limits,
  );
  return parseRecoveryChanges(raw, limits);
}

/** Structural selection before strict recovery activation; retains the ordinary caller's environment. */
export async function readSyncIncomingChanges(
  cwd: string,
  limits: RecoveryGitLimits,
): Promise<{ head: string; incoming: string; changes: RecoveryGitChange[] }> {
  assertRecoveryLimits(limits);
  const { stdout: refs } = await exec('git', ['rev-parse', 'HEAD', '@{upstream}'], {
    cwd,
    maxBuffer: limits.maxBytes,
  });
  const [head, incoming] = refs.trim().split('\n');
  assertRecoveryOid(head);
  assertRecoveryOid(incoming);
  const { stdout } = await exec(
    'git',
    [
      'diff-tree',
      '--raw',
      '-z',
      '-r',
      '--no-renames',
      '--no-abbrev',
      '--no-commit-id',
      head,
      incoming,
    ],
    { cwd, maxBuffer: limits.maxBytes, encoding: 'buffer' },
  );
  return {
    head,
    incoming,
    changes: parseRecoveryChanges(recoveryText(Buffer.from(stdout)), limits),
  };
}

function parseRecoveryChanges(raw: string, limits: RecoveryGitLimits): RecoveryGitChange[] {
  const records = boundedRecords(raw, { ...limits, maxEntries: limits.maxEntries * 2 });
  const changes: RecoveryGitChange[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(records[index]);
    if (!match || records[index + 1] === undefined)
      throw new Error('Unsupported structured Git delta');
    const path = records[index + 1];
    assertRecoveryPath(path);
    changes.push({
      path,
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      status: match[5] as RecoveryGitChange['status'],
    });
  }
  return changes;
}

/** Include file/directory ancestor collisions, not just equal filenames. */
export function recoveryPathsOverlap(left: string, right: string): boolean {
  assertRecoveryPath(left);
  assertRecoveryPath(right);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Read one pinned directory's bounded metadata; never descend or load payload blobs. */
export async function readRecoveryDirectory(
  cwd: string,
  tree: string,
  limits: RecoveryGitLimits,
): Promise<RecoveryDirectoryEntry[]> {
  assertRecoveryOid(tree);
  const raw = await recoveryGitText(cwd, ['ls-tree', '-z', tree], limits);
  return boundedRecords(raw, limits).map((row) => {
    const match =
      /^(040000|100644|100755|120000|160000) (blob|tree|commit) ([a-f0-9]+)\t([^\/\0]+)$/.exec(row);
    if (!match || match[4] === '.' || match[4] === '..')
      throw new Error('Unsupported pinned recovery directory entry');
    assertRecoveryOid(match[3]);
    const kind =
      match[1] === '040000'
        ? 'directory'
        : ['100644', '100755'].includes(match[1])
          ? 'file'
          : 'other';
    if (match[2] !== (kind === 'directory' ? 'tree' : match[1] === '160000' ? 'commit' : 'blob'))
      throw new Error('Pinned recovery directory mode/type mismatch');
    return { name: match[4], mode: match[1], oid: match[3], kind };
  });
}

/** Verify the actual commit tree, including outputs outside the current path group. */
export async function verifyRecoveryCommitTree(
  cwd: string,
  commit: string,
  expected: readonly RecoveryStageEntry[],
  limits: RecoveryGitLimits,
): Promise<void> {
  assertRecoveryOid(commit);
  const records = boundedRecords(
    await recoveryGitText(cwd, ['ls-tree', '-r', '-z', commit], limits),
    limits,
  );
  const entries = new Map(expected.map((entry) => [entry.path, entry]));
  if (records.length !== entries.size) throw new Error('Actual recovery commit tree differs');
  for (const row of records) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Unsupported actual recovery commit tree entry');
    const entry = entries.get(match[4]);
    if (
      !entry ||
      entry.mode !== match[1] ||
      entry.oid !== match[3] ||
      match[2] !== (match[1] === '160000' ? 'commit' : 'blob')
    )
      throw new Error('Actual recovery commit tree differs');
  }
}

async function recoveryConfig(
  cwd: string,
  limits: RecoveryGitLimits,
): Promise<RecoveryConfigEntry[]> {
  const records = boundedRecords(
    await recoveryGitText(
      cwd,
      ['config', '--null', '--show-origin', '--show-scope', '--includes', '--list'],
      limits,
    ),
    { ...limits, maxEntries: limits.maxEntries * 3 },
  );
  const entries: RecoveryConfigEntry[] = [];
  for (let index = 0; index < records.length; index += 3) {
    const separator = records[index + 2]?.indexOf('\n') ?? -1;
    if (separator < 0 || !records[index + 1].startsWith('file:')) {
      throw new Error('Unknown recovery Git configuration origin');
    }
    entries.push({
      scope: records[index],
      origin: records[index + 1].slice(5),
      key: records[index + 2].slice(0, separator),
      value: records[index + 2].slice(separator + 1),
    });
  }
  return entries;
}

function configValues(config: RecoveryConfigEntry[], key: string): string[] {
  return config
    .filter((entry) => entry.key.toLowerCase() === key.toLowerCase())
    .map((entry) => entry.value);
}

/** Observe full attached/upstream identity and exact stage-zero entries/flags; never restore an index. */
export async function readRecoveryGitState(
  cwd: string,
  limits: RecoveryGitLimits,
  { allowStaged = false }: { allowStaged?: boolean } = {},
): Promise<RecoveryGitState> {
  const text = (args: string[]) => recoveryGitText(cwd, args, limits);
  const root = (await text(['rev-parse', '--show-toplevel'])).trimEnd();
  if (
    resolve(root) !== resolve(cwd) ||
    (await text(['rev-parse', '--is-bare-repository'])).trim() !== 'false'
  ) {
    throw new Error('Recovery requires the ordinary non-bare worktree root');
  }
  const gitDir = (await text(['rev-parse', '--absolute-git-dir'])).trimEnd();
  const branch = (await text(['symbolic-ref', '--quiet', 'HEAD'])).trimEnd();
  if (!branch.startsWith('refs/heads/')) throw new Error('Recovery requires an attached branch');
  const head = (await text(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  const upstream = (await text(['rev-parse', '--symbolic-full-name', '@{upstream}'])).trimEnd();
  const upstreamOid = (await text(['rev-parse', '--verify', '@{upstream}^{commit}'])).trim();
  assertRecoveryOid(head);
  assertRecoveryOid(upstreamOid);
  const config = await recoveryConfig(cwd, limits);
  for (const key of ['core.sparsecheckout', 'core.sparsecheckoutcone', 'index.sparse']) {
    if (configValues(config, key).some((value) => value !== 'false'))
      throw new Error(`Unsupported sparse Git state: ${key}`);
  }
  if (await inProgressOperation(gitDir)) throw new Error('Recovery Git operation in progress');
  for (const name of ['index.lock', 'sequencer', 'BISECT_LOG']) {
    if (
      await fs.lstat(join(gitDir, name)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      })
    )
      throw new Error(`Recovery Git operation state: ${name}`);
  }
  const refRows = (
    await text([
      'for-each-ref',
      '--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(push)%00%(push:remotename)%00%(push:remoteref)',
      branch,
    ])
  )
    .trimEnd()
    .split('\n');
  const ref = refRows.map((row) => row.split('\0')).find((row) => row[0] === branch);
  if (!ref || ref.length !== 7 || ref[1] !== upstream)
    throw new Error('Unresolved upstream destination');
  const remote = ref[2];
  const mergeRef = ref[3];
  if (
    configValues(config, `branch.${branch.slice(11)}.remote`).join('\0') !== remote ||
    configValues(config, `branch.${branch.slice(11)}.merge`).join('\0') !== mergeRef
  ) {
    throw new Error('Ambiguous branch upstream configuration');
  }
  const remoteUrls =
    remote === '.'
      ? [root]
      : (await text(['remote', 'get-url', '--all', remote])).trimEnd().split('\n');
  const pushRemote = ref[5];
  let pushMergeRef = ref[6];
  if (
    !pushMergeRef &&
    pushRemote &&
    configValues(config, `remote.${pushRemote}.push`).length === 0
  ) {
    const pushDefault = configValues(config, 'push.default').at(-1) ?? 'simple';
    if (pushDefault === 'current' || (pushDefault === 'simple' && pushRemote !== remote)) {
      pushMergeRef = branch;
    } else if (
      pushRemote === remote &&
      (pushDefault === 'upstream' || (pushDefault === 'simple' && branch === mergeRef))
    ) {
      pushMergeRef = mergeRef;
    }
  }
  const pushUrls =
    pushRemote === '.'
      ? [root]
      : pushRemote
        ? (await text(['remote', 'get-url', '--push', '--all', pushRemote])).trimEnd().split('\n')
        : [];
  const entries: RecoveryStageEntry[] = [];
  const stageRaw = await text(['ls-files', '--sparse', '--stage', '-v', '-z']);
  for (const row of boundedRecords(stageRaw, limits)) {
    const match = /^(.?) (\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match || match[1] !== 'H' || match[4] !== '0' || match[2] === '040000') {
      throw new Error('Unsupported unmerged, hidden, or sparse stage entry');
    }
    assertRecoveryPath(match[5]);
    entries.push({
      path: match[5],
      mode: match[2],
      oid: match[3],
      stage: 0,
      flag: match[1],
      flags: '',
    });
  }
  const debug = await text(['ls-files', '--debug', '-z']);
  let cursor = 0;
  for (const entry of entries) {
    const end = debug.indexOf('\0', cursor);
    const details =
      /^  ctime:[^\n]*\n  mtime:[^\n]*\n  dev:[^\n]*\n  uid:[^\n]*\n  size:[^\n]*\tflags: ([0-9a-f]+)\n/.exec(
        debug.slice(end + 1),
      );
    if (debug.slice(cursor, end) !== entry.path || !details)
      throw new Error('Unknown Git index flag representation');
    entry.flags = details[1];
    if ((Number.parseInt(entry.flags, 16) & 0x60008000) !== 0)
      throw new Error('Intent-to-add or hidden Git index flags');
    cursor = end + 1 + details[0].length;
  }
  if (cursor !== debug.length) throw new Error('Git index listing drift');
  const staged = await text([
    'diff-index',
    '--cached',
    '--raw',
    '--no-abbrev',
    '-z',
    '--no-renames',
    '--ita-visible-in-index',
    head,
  ]);
  if (!allowStaged && staged !== '') throw new Error('Recovery refuses staged deltas');
  return {
    root,
    gitDir,
    head,
    branch,
    upstream,
    upstreamOid,
    remote,
    mergeRef,
    pushRef: ref[4],
    pushRemote,
    pushMergeRef,
    remoteUrls,
    pushUrls,
    config,
    entries,
    staged,
  };
}

/** Recheck every recorded identity; callers explicitly supply expected own HEAD/stage transitions. */
export async function assertRecoveryGitState(
  cwd: string,
  expected: RecoveryGitState,
  limits: RecoveryGitLimits,
): Promise<void> {
  const current = await readRecoveryGitState(cwd, limits, { allowStaged: expected.staged !== '' });
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new Error('Recovery Git identity or index drift');
}

/** Require the pinned behind-only relationship without interpreting a Git diagnostic. */
export async function assertRecoveryFastForward(
  cwd: string,
  state: RecoveryGitState,
  limits: RecoveryGitLimits,
): Promise<void> {
  await assertRecoveryGitState(cwd, state, limits);
  if (state.head === state.upstreamOid) throw new Error('Recovery is not behind upstream');
  await recoveryGit(cwd, ['merge-base', '--is-ancestor', state.head, state.upstreamOid], limits);
}

/** Read authoritative raw blob bytes after a bounded size/type query; no filters or text decoding. */
export async function readRecoveryBlob(
  cwd: string,
  oid: string,
  limits: RecoveryGitLimits,
  reserve?: (size: number) => void,
): Promise<Buffer> {
  assertRecoveryLimits(limits);
  assertRecoveryOid(oid);
  // Object metadata has a fixed small bound independent of the permitted blob size.
  const metadataLimits = { ...limits, maxBytes: Math.max(128, limits.maxBytes) };
  const type = (await recoveryGitText(cwd, ['cat-file', '-t', oid], metadataLimits)).trim();
  if (type !== 'blob') throw new Error('Recovery object is not a blob');
  const rawSize = (await recoveryGitText(cwd, ['cat-file', '-s', oid], metadataLimits)).trim();
  const size = Number(rawSize);
  if (!/^\d+$/.test(rawSize) || !Number.isSafeInteger(size) || size > limits.maxBytes) {
    throw new Error('Recovery blob byte limit exceeded');
  }
  reserve?.(size);
  const bytes = await recoveryGit(cwd, ['cat-file', 'blob', oid], limits);
  if (bytes.length !== size) throw new Error('Recovery blob size mismatch');
  return bytes;
}

async function recoveryTreeEntries(
  cwd: string,
  tree: string,
  paths: readonly string[],
  limits: RecoveryGitLimits,
): Promise<Map<string, { mode: string; oid: string }>> {
  assertRecoveryOid(tree);
  const entries = new Map<string, { mode: string; oid: string }>();
  for (let offset = 0; offset < paths.length; offset += ADD_CHUNK) {
    const raw = await recoveryGitText(
      cwd,
      ['ls-tree', '-z', tree, '--', ...paths.slice(offset, offset + ADD_CHUNK)],
      limits,
    );
    for (const row of boundedRecords(raw, limits)) {
      const match = /^(\d{6}) (?:blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error('Unknown Git tree entry');
      entries.set(match[3], { mode: match[1], oid: match[2] });
      if (entries.size > limits.maxEntries) throw new Error('Recovery Git entry limit exceeded');
    }
  }
  return entries;
}

/** Check actual staged or committed selected output blobs, not the proposed worktree alone. */
export async function verifyRecoveryOutputObjects(
  cwd: string,
  source: { stage: readonly RecoveryStageEntry[] } | { commit: string },
  outputs: readonly { path: string; bytes: Buffer }[],
  limits: RecoveryGitLimits,
): Promise<void> {
  if (outputs.length > limits.maxEntries) throw new Error('Recovery output count limit exceeded');
  for (const output of outputs) assertRecoveryPath(output.path);
  const entries =
    'commit' in source
      ? await recoveryTreeEntries(
          cwd,
          source.commit,
          outputs.map((output) => output.path),
          limits,
        )
      : new Map(source.stage.map((entry) => [entry.path, entry]));
  for (const output of outputs) {
    const entry = entries.get(output.path);
    if (
      !entry ||
      entry.mode !== '100644' ||
      !(await readRecoveryBlob(cwd, entry.oid, limits)).equals(output.bytes)
    ) {
      throw new Error(`Recovery output object mismatch: ${JSON.stringify(output.path)}`);
    }
  }
}

function attributePaths(paths: readonly string[], limits: RecoveryGitLimits): string[] {
  const attributes = new Set<string>(['.gitattributes']);
  for (const path of paths) {
    assertRecoveryPath(path);
    const parts = path.split('/');
    for (let length = 1; length < parts.length; length++) {
      attributes.add(`${parts.slice(0, length).join('/')}/.gitattributes`);
      if (attributes.size > limits.maxEntries)
        throw new Error('Recovery attribute count limit exceeded');
    }
  }
  return [...attributes].sort();
}

function attributeEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    [
      'HOME',
      'XDG_CONFIG_HOME',
      'PATH',
      'GIT_ATTR_SYSTEM',
      'GIT_ATTR_GLOBAL',
      'GIT_ATTR_NOSYSTEM',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
    ].map((key) => [key, process.env[key]]),
  );
}

async function readRecoveryDependency(
  path: string,
  limits: RecoveryGitLimits,
  binary = false,
): Promise<RecoveryDependency> {
  if (path === '/dev/null') return { path, identity: 'null-device', sha256: null, size: 0 };
  const stat = await fs.lstat(path, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return { path, identity: null, sha256: null, size: 0 };
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limits.maxBytes)) {
    throw new Error(`Unsupported recovery dependency: ${JSON.stringify(path)}`);
  }
  const identity = (value: typeof stat) =>
    [
      value.dev,
      value.ino,
      value.mode,
      value.uid,
      value.gid,
      value.nlink,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ].join(':');
  const before = identity(stat);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(await handle.stat({ bigint: true })) !== before)
      throw new Error('Recovery dependency identity drift');
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (
      length !== Number(stat.size) ||
      identity(await handle.stat({ bigint: true })) !== before ||
      identity(await fs.lstat(path, { bigint: true })) !== before
    )
      throw new Error('Recovery dependency changed during read');
    if (!binary) {
      recoveryText(bytes.subarray(0, length));
      if (bytes.subarray(0, length).includes(0))
        throw new Error('NUL in recovery configuration/attribute dependency');
    }
    return {
      path,
      identity: before,
      size: length,
      sha256: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

function resolveConfigPath(value: string, origin: string): string {
  if (value === '~' || value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  if (value.startsWith('~') || value.includes('\0') || value === '')
    throw new Error('Unknown config dependency path');
  return isAbsolute(value) ? value : resolve(dirname(origin), value);
}

async function recoveryDependencyPaths(
  cwd: string,
  gitDir: string,
  config: RecoveryConfigEntry[],
  attributes: string[],
  limits: RecoveryGitLimits,
): Promise<string[]> {
  const paths = new Set(attributes.map((path) => resolve(cwd, path)));
  paths.add(join(gitDir, 'info', 'attributes'));
  const resolvedVariables = (await recoveryGitText(cwd, ['var', '-l'], limits)).split('\n');
  for (const variable of [
    'GIT_ATTR_SYSTEM',
    'GIT_ATTR_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
  ]) {
    if (!resolvedVariables.some((line) => line.startsWith(`${variable}=`))) {
      const disabledBy =
        variable === 'GIT_ATTR_SYSTEM'
          ? process.env.GIT_ATTR_NOSYSTEM
          : variable === 'GIT_CONFIG_SYSTEM'
            ? process.env.GIT_CONFIG_NOSYSTEM
            : undefined;
      if (disabledBy !== undefined) continue;
      throw new Error(`Unsupported Git dependency resolution: ${variable}`);
    }
    const values = (await recoveryGitText(cwd, ['var', variable], limits)).trimEnd().split('\n');
    for (const value of values) {
      if (value) {
        if (!isAbsolute(value)) throw new Error('Unresolved Git attribute/configuration path');
        paths.add(value);
      }
    }
  }
  for (const entry of config) {
    const origin = resolve(cwd, entry.origin);
    paths.add(origin);
    if (entry.key.toLowerCase() === 'include.path' || /^includeif\..+\.path$/i.test(entry.key)) {
      paths.add(resolveConfigPath(entry.value, origin));
    }
  }
  if (paths.size > limits.maxEntries) throw new Error('Recovery dependency count limit exceeded');
  return [...paths].sort();
}

async function checkRecoveryAttributes(
  cwd: string,
  paths: readonly string[],
  limits: RecoveryGitLimits,
  index?: string,
): Promise<{ path: string; attribute: string; value: string }[]> {
  const attributes: { path: string; attribute: string; value: string }[] = [];
  for (let offset = 0; offset < paths.length; offset += ADD_CHUNK) {
    const selected = paths.slice(offset, offset + ADD_CHUNK);
    const records = boundedRecords(
      await recoveryGitText(
        cwd,
        [
          'check-attr',
          ...(index ? ['--cached'] : []),
          '-z',
          ...OUTPUT_ATTRIBUTES,
          '--',
          ...selected,
        ],
        limits,
        { index },
      ),
      { ...limits, maxEntries: limits.maxEntries * OUTPUT_ATTRIBUTES.length * 3 },
    );
    if (records.length !== selected.length * OUTPUT_ATTRIBUTES.length * 3)
      throw new Error('Incomplete attribute proof');
    for (let position = 0; position < records.length; position += 3) {
      const path = records[position];
      const attribute = records[position + 1];
      const value = records[position + 2];
      if (
        path !== selected[Math.floor(position / (OUTPUT_ATTRIBUTES.length * 3))] ||
        attribute !== OUTPUT_ATTRIBUTES[(position / 3) % OUTPUT_ATTRIBUTES.length]
      )
        throw new Error('Unknown attribute response');
      if (value !== 'unspecified' && value !== 'unset') {
        throw new Error(
          `Non-inert output attribute ${attribute}=${value}: ${JSON.stringify(path)}`,
        );
      }
      attributes.push({ path, attribute, value });
    }
  }
  return attributes;
}

async function syncRecoveryProofPath(path: string): Promise<void> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Prove all selected outputs inert at H/M/current without checkout or executing conversion programs. */
export async function proveInertRecoveryOutputs(
  cwd: string,
  head: string,
  incoming: string,
  paths: readonly string[],
  privateDirectory: string,
  limits: RecoveryGitLimits,
): Promise<RecoveryAttributeProof> {
  assertRecoveryLimits(limits);
  assertRecoveryEnvironment();
  assertRecoveryOid(head);
  assertRecoveryOid(incoming);
  if (paths.length > limits.maxEntries || new Set(paths).size !== paths.length)
    throw new Error('Recovery output count/identity limit exceeded');
  const privateStat = await fs.lstat(privateDirectory);
  if (
    !privateStat.isDirectory() ||
    (privateStat.mode & 0o777) !== 0o700 ||
    (process.getuid && privateStat.uid !== process.getuid()) ||
    (await fs.realpath(privateDirectory)) !== resolve(privateDirectory)
  )
    throw new Error('Unsafe private attribute-proof directory');
  const config = await recoveryConfig(cwd, limits);
  const autocrlf = configValues(config, 'core.autocrlf').at(-1) ?? 'false';
  if (autocrlf !== 'false') throw new Error('Recovery outputs require core.autocrlf=false');
  const gitDir = (
    await recoveryGitText(cwd, ['rev-parse', '--absolute-git-dir'], limits)
  ).trimEnd();
  const trackedAttributes = attributePaths(paths, limits);
  const dependencyPaths = await recoveryDependencyPaths(
    cwd,
    gitDir,
    config,
    trackedAttributes,
    limits,
  );
  const dependencies: RecoveryDependency[] = [];
  for (const path of dependencyPaths) dependencies.push(await readRecoveryDependency(path, limits));
  const indexAttributes = await recoveryGitText(
    cwd,
    ['ls-files', '--stage', '-z', '--', ...trackedAttributes],
    limits,
  );
  for (const row of boundedRecords(indexAttributes, limits)) {
    const entry = /^(100644|100755) ([0-9a-f]+) 0\t[\s\S]+$/.exec(row);
    if (!entry) throw new Error('Unsupported live-index attribute file type/stage');
    const bytes = await readRecoveryBlob(cwd, entry[2], limits);
    recoveryText(bytes);
    if (bytes.includes(0)) throw new Error('NUL in committed attribute file');
  }
  const proof: RecoveryAttributeProof = {
    head,
    incoming,
    paths: [...paths],
    config,
    dependencies,
    attributes: [],
    privateIndexes: [],
    indexAttributes,
    environment: attributeEnvironment(),
  };
  for (const [epoch, tree] of [
    ['head', head],
    ['incoming', incoming],
  ] as const) {
    const directory = await fs.mkdtemp(join(privateDirectory, 'attributes-'));
    await syncRecoveryProofPath(directory);
    await syncRecoveryProofPath(privateDirectory);
    const index = join(directory, 'index');
    const entries = await recoveryTreeEntries(cwd, tree, trackedAttributes, limits);
    await recoveryGit(cwd, ['read-tree', '--empty'], limits, { index });
    const rows: string[] = [];
    for (const [path, entry] of entries) {
      if (!['100644', '100755'].includes(entry.mode))
        throw new Error('Unsupported committed attribute file type');
      // Bound each attribute blob before Git's attribute machinery opens it.
      const bytes = await readRecoveryBlob(cwd, entry.oid, limits);
      recoveryText(bytes);
      if (bytes.includes(0)) throw new Error('NUL in committed attribute file');
      rows.push(`${entry.mode} ${entry.oid}\t${path}\0`);
    }
    if (rows.length) {
      const input = Buffer.from(rows.join(''));
      if (input.length > limits.maxBytes)
        throw new Error('Recovery attribute index input limit exceeded');
      await recoveryGit(cwd, ['update-index', '-z', '--index-info'], limits, { index, input });
    }
    await fs.chmod(index, 0o600);
    await syncRecoveryProofPath(index);
    await syncRecoveryProofPath(directory);
    proof.privateIndexes.push(index);
    proof.dependencies.push(await readRecoveryDependency(index, limits, true));
    proof.attributes.push(
      ...(await checkRecoveryAttributes(cwd, paths, limits, index)).map((value) => ({
        epoch,
        ...value,
      })),
    );
  }
  proof.attributes.push(
    ...(await checkRecoveryAttributes(cwd, paths, limits)).map((value) => ({
      epoch: 'current' as const,
      ...value,
    })),
  );
  await assertRecoveryAttributeProof(cwd, proof, limits);
  return proof;
}

/** Reject changed config/includes/attributes/index resolution; repeat immediately at each write/add/commit boundary. */
export async function assertRecoveryAttributeProof(
  cwd: string,
  proof: RecoveryAttributeProof,
  limits: RecoveryGitLimits,
): Promise<void> {
  assertRecoveryLimits(limits);
  assertRecoveryEnvironment();
  if (
    JSON.stringify(attributeEnvironment()) !== JSON.stringify(proof.environment) ||
    JSON.stringify(await recoveryConfig(cwd, limits)) !== JSON.stringify(proof.config)
  ) {
    throw new Error('Recovery attribute configuration drift');
  }
  const gitDir = (
    await recoveryGitText(cwd, ['rev-parse', '--absolute-git-dir'], limits)
  ).trimEnd();
  const attributes = attributePaths(proof.paths, limits);
  const paths = await recoveryDependencyPaths(cwd, gitDir, proof.config, attributes, limits);
  const originalPaths = proof.dependencies
    .filter((dependency) => !proof.privateIndexes.includes(dependency.path))
    .map((dependency) => dependency.path);
  if (JSON.stringify(paths) !== JSON.stringify(originalPaths))
    throw new Error('Recovery dependency resolution drift');
  for (const dependency of proof.dependencies) {
    if (
      JSON.stringify(
        await readRecoveryDependency(
          dependency.path,
          limits,
          proof.privateIndexes.includes(dependency.path),
        ),
      ) !== JSON.stringify(dependency)
    ) {
      throw new Error(`Recovery attribute dependency drift: ${JSON.stringify(dependency.path)}`);
    }
  }
  if (
    (await recoveryGitText(cwd, ['ls-files', '--stage', '-z', '--', ...attributes], limits)) !==
    proof.indexAttributes
  ) {
    throw new Error('Recovery attribute index drift');
  }
  for (const [position, epoch] of ['head', 'incoming', 'current'].entries()) {
    const current = await checkRecoveryAttributes(
      cwd,
      proof.paths,
      limits,
      proof.privateIndexes[position],
    );
    if (
      JSON.stringify(current.map((value) => ({ epoch, ...value }))) !==
      JSON.stringify(proof.attributes.filter((value) => value.epoch === epoch))
    )
      throw new Error('Recovery attribute value drift');
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
