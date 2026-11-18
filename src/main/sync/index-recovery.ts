/** Recovery-only protection and resource foundations; no sync caller activates a transaction yet. */
import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { indexHumanContent, enumerateIndexPaths, type IndexRecoveryInput } from '../index-tree';
import { projectsStrategy } from '../index-projects';
import { knowledgeStrategy } from '../index-knowledge';
import { exec } from '../exec';
import { iterUnfencedLines } from '../../shared/header';
import {
  assertRecoveryGitState,
  readRecoveryGitState,
  readRecoveryBlob,
  type RecoveryGitState,
  type RecoveryAttributeProof,
  type RecoveryGitChange,
  type ChangedPath,
  recoveryPathsOverlap,
} from './git';
import {
  acquireDeferredSyncLock,
  acquireManualResolutionLock,
  acquireRecoveryLease,
  readProcessIdentity,
  inspectRecoveryEvidence,
  persistRecoverySyncLock,
  retainRecoverySyncLock,
  readSyncLockToken,
  releaseRecoverySyncLock,
  type RecoveryLease,
  type SyncLock,
  type SyncLockToken,
} from './lock';

export const RECOVERY_LIMITS = {
  entries: 100_000,
  candidates: 1_000,
  indexBytes: 8 * 1024 * 1024,
  journalBytes: 128 * 1024 * 1024,
  preflightMs: 120_000,
  emergencyBytes: 64 * 1024,
} as const;

export interface RecoveryResources {
  entries: number;
  candidates: number;
  usedBytes: number;
  reservedBytes: number;
  emergencyUsedBytes: number;
}

/** Query-local Git bounds supplement, rather than replace, this transaction-wide accounting. */
export class RecoveryBudget {
  private readonly startedAt: number;
  private resources: RecoveryResources;

  constructor(
    private readonly now: () => number = () => performance.now(),
    retained?: RecoveryResources,
  ) {
    this.startedAt = now();
    this.resources = retained
      ? { ...retained }
      : {
          entries: 0,
          candidates: 0,
          usedBytes: 0,
          reservedBytes: 0,
          emergencyUsedBytes: 0,
        };
    for (const value of Object.values(this.resources)) this.assertCount(value);
    this.assertWithinLimits();
  }

  snapshot(): RecoveryResources {
    return { ...this.resources };
  }

  checkPreflight(): void {
    const elapsed = this.now() - this.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > RECOVERY_LIMITS.preflightMs)
      throw new Error('Recovery preflight deadline exceeded');
  }

  countEntries(count = 1): void {
    this.checkPreflight();
    this.assertCount(count);
    if (this.resources.entries + count > RECOVERY_LIMITS.entries)
      throw new Error('Recovery relevant-entry limit exceeded');
    this.resources.entries += count;
  }

  countCandidate(): void {
    this.checkPreflight();
    if (this.resources.candidates >= RECOVERY_LIMITS.candidates)
      throw new Error('Recovery candidate limit exceeded');
    this.resources.candidates++;
  }

  countDynamicEntries(count = 1): void {
    this.assertCount(count);
    if (this.resources.entries + count > RECOVERY_LIMITS.entries)
      throw new Error('Recovery relevant-entry limit exceeded');
    this.resources.entries += count;
  }

  assertIndexBytes(size: number): void {
    this.assertCount(size);
    if (size > RECOVERY_LIMITS.indexBytes)
      throw new Error('Recovery protected-index byte limit exceeded');
  }

  /** Reserve saved L/B/A/G, metadata and publication-temporary allowance before normalization. */
  reserve(bytes: number): void {
    this.assertCount(bytes);
    if (
      this.resources.usedBytes + this.resources.reservedBytes + bytes >
      RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes
    )
      throw new Error('Recovery journal reservation limit exceeded');
    this.resources.reservedBytes += bytes;
  }

  consume(bytes: number): void {
    this.assertCount(bytes);
    if (bytes > this.resources.reservedBytes) throw new Error('Unreserved recovery evidence bytes');
    this.resources.reservedBytes -= bytes;
    this.resources.usedBytes += bytes;
  }

  consumeEmergency(bytes: number): void {
    this.assertCount(bytes);
    if (this.resources.emergencyUsedBytes + bytes > RECOVERY_LIMITS.emergencyBytes)
      throw new Error('Recovery emergency evidence limit exceeded');
    this.resources.emergencyUsedBytes += bytes;
  }

  releaseReplacedManifest(bytes: number): void {
    this.assertCount(bytes);
    if (bytes > this.resources.usedBytes) throw new Error('Invalid replaced manifest accounting');
    this.resources.usedBytes -= bytes;
  }

  releaseReservation(bytes: number): void {
    this.assertCount(bytes);
    if (bytes > this.resources.reservedBytes)
      throw new Error('Invalid recovery reservation release');
    this.resources.reservedBytes -= bytes;
  }

  private assertCount(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid recovery resource count');
  }

  private assertWithinLimits(): void {
    if (
      this.resources.entries > RECOVERY_LIMITS.entries ||
      this.resources.candidates > RECOVERY_LIMITS.candidates ||
      this.resources.emergencyUsedBytes > RECOVERY_LIMITS.emergencyBytes ||
      this.resources.usedBytes + this.resources.reservedBytes >
        RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes
    )
      throw new Error('Retained recovery resources exceed limits');
  }
}

interface RawIndexLine {
  span: string;
  body: string;
  drafted: boolean;
}

/** Validate before parsing; preserve terminators and the absence of a terminator at EOF. */
function recoveryLines(bytes: Buffer): RawIndexLine[] {
  if (bytes.length > RECOVERY_LIMITS.indexBytes)
    throw new Error('Recovery protected-index byte limit exceeded');
  const text = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes))
    throw new Error('Unsupported recovery index encoding');
  const withoutCrLf = text.replace(/\r\n/g, '');
  if (withoutCrLf.includes('\r') || (text.includes('\r\n') && withoutCrLf.includes('\n')))
    throw new Error('Unsupported mixed recovery index EOL');
  const spans = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bodies = spans.map((span) =>
    span.endsWith('\r\n') ? span.slice(0, -2) : span.endsWith('\n') ? span.slice(0, -1) : span,
  );
  const unfenced = new Set(Array.from(iterUnfencedLines(bodies), ({ index }) => index));
  return spans.map((span, index) => ({
    span,
    body: bodies[index],
    // Reuse the existing conservative ownership predicate, with the shared fence tracker.
    drafted:
      unfenced.has(index) && bodies[index].trim() !== '' && indexHumanContent(bodies[index]) === '',
  }));
}

/** Candidate eligibility preserves every raw non-draft span, including blanks and EOL. */
export function recoveryCandidateQualifies(local: Buffer, head: Buffer): boolean {
  const nonDraft = (bytes: Buffer) =>
    recoveryLines(bytes)
      .filter((line) => !line.drafted)
      .map((line) => line.span)
      .join('');
  return nonDraft(local) === nonDraft(head);
}

/** Serialized nonblank protected spans; base64 retains bytes without newline normalization. */
export function recoveryProtectedSpans(bytes: Buffer): string[] {
  return recoveryLines(bytes)
    .filter((line) => !line.drafted && line.body.trim() !== '')
    .map((line) => Buffer.from(line.span).toString('base64'));
}

/** Each requirement is independent; duplicate multiplicity and order are preserved within it. */
export function assertRecoveryRequirements(
  bytes: Buffer | null,
  requirements: readonly (readonly string[])[],
): void {
  if (!bytes) {
    if (requirements.some((sequence) => sequence.length !== 0))
      throw new Error('Required recovery index vanished');
    return;
  }
  const spans = recoveryLines(bytes).map((line) => Buffer.from(line.span).toString('base64'));
  for (const sequence of requirements) {
    let cursor = 0;
    for (const span of spans) if (cursor < sequence.length && span === sequence[cursor]) cursor++;
    if (cursor !== sequence.length) throw new Error('Protected recovery sequence lost');
  }
}

export interface RecoveryProtection {
  path: string;
  role: 'output' | 'source';
  incoming: 'unchanged' | 'modified' | 'added' | 'deleted';
  adopted: boolean;
  localHash: string | null;
  incomingHash: string | null;
  requirements: string[][];
}

/** Select the complete structural overlap batch; raw-byte/type/attribute proofs are still required before normalization. */
export function selectRecoveryCandidatePaths(
  changed: readonly ChangedPath[],
  incoming: readonly RecoveryGitChange[],
  outputs: ReadonlySet<string>,
  state: RecoveryGitState,
): string[] {
  if (
    changed.length > RECOVERY_LIMITS.entries ||
    incoming.length > RECOVERY_LIMITS.entries ||
    state.entries.length > RECOVERY_LIMITS.entries
  )
    throw new Error('Recovery overlap entry limit exceeded');
  const candidates = new Set<string>();
  const entries = new Map(state.entries.map((entry) => [entry.path, entry]));
  const incomingByPath = new Map<string, RecoveryGitChange>();
  for (const change of incoming) {
    recoveryPathsOverlap(change.path, change.path);
    if (incomingByPath.has(change.path)) throw new Error('Duplicate incoming recovery delta');
    incomingByPath.set(change.path, change);
  }
  const incomingPaths = [...incomingByPath.keys()].sort(comparePaths);
  for (const local of changed) {
    recoveryPathsOverlap(local.path, local.path);
    const remote = incomingByPath.get(local.path);
    const entry = entries.get(local.path);
    const parts = local.path.split('/');
    let ancestor = '';
    let ancestorCollision = false;
    for (const part of parts.slice(0, -1)) {
      ancestor = ancestor ? `${ancestor}/${part}` : part;
      if (incomingByPath.has(ancestor)) {
        ancestorCollision = true;
        break;
      }
    }
    const prefix = `${local.path}/`;
    let low = 0;
    let high = incomingPaths.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (comparePaths(incomingPaths[middle], prefix) < 0) low = middle + 1;
      else high = middle;
    }
    const descendantCollision = incomingPaths[low]?.startsWith(prefix) ?? false;
    if (!remote && !ancestorCollision && !descendantCollision) continue;
    if (
      !remote ||
      ancestorCollision ||
      descendantCollision ||
      !outputs.has(local.path) ||
      local.newToHead ||
      local.deleted ||
      local.conflicted ||
      remote.status !== 'M' ||
      remote.oldMode !== '100644' ||
      remote.newMode !== '100644' ||
      !entry ||
      entry.mode !== '100644' ||
      entry.oid !== remote.oldOid ||
      entry.stage !== 0 ||
      entry.flag !== 'H' ||
      !/^[0-9a-f]{1,8}$/.test(entry.flags) ||
      (Number.parseInt(entry.flags, 16) & 0x60008000) !== 0 ||
      state.staged !== ''
    ) {
      throw new Error(`Unsupported local/incoming recovery overlap: ${JSON.stringify(local.path)}`);
    }
    candidates.add(local.path);
    if (candidates.size > RECOVERY_LIMITS.candidates)
      throw new Error('Recovery candidate limit exceeded');
  }
  return [...candidates].sort(comparePaths);
}

function bytesHash(bytes: Buffer | null): string | null {
  return bytes ? createHash('sha256').update(bytes).digest('hex') : null;
}

function addRequirement(record: RecoveryProtection, bytes: Buffer | null): RecoveryProtection {
  const requirements = record.requirements.map((sequence) => [...sequence]);
  if (bytes) {
    const next = recoveryProtectedSpans(bytes);
    if (!requirements.some((sequence) => JSON.stringify(sequence) === JSON.stringify(next)))
      requirements.push(next);
  }
  return { ...record, requirements };
}

/** Choose the approved incoming epoch once; a deferred run must retain this record, not prepare anew. */
export function prepareRecoveryProtection(
  path: string,
  role: RecoveryProtection['role'],
  incoming: RecoveryProtection['incoming'],
  local: Buffer | null,
  head: Buffer | null,
  incomingBytes: Buffer | null,
  candidate = false,
): RecoveryProtection {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.includes('\0')
  )
    throw new Error('Invalid protected recovery path');
  for (const bytes of [local, head, incomingBytes]) if (bytes) recoveryLines(bytes);
  if (
    candidate &&
    (role !== 'output' ||
      incoming !== 'modified' ||
      !local ||
      !head ||
      !incomingBytes ||
      !recoveryCandidateQualifies(local, head))
  )
    throw new Error('Unsupported local recovery candidate');
  if ((incoming === 'modified' || incoming === 'added') && !incomingBytes)
    throw new Error('Missing pinned incoming recovery index');
  if (
    incoming === 'deleted' &&
    [local, head].some((bytes) => bytes && recoveryProtectedSpans(bytes).length)
  )
    throw new Error('Incoming deletion of protected recovery index');
  const record: RecoveryProtection = {
    path,
    role,
    incoming,
    adopted: false,
    localHash: bytesHash(local),
    incomingHash: bytesHash(incomingBytes),
    requirements: [],
  };
  if (incoming === 'unchanged') return addRequirement(record, local);
  if (role === 'output' && incoming !== 'deleted') return addRequirement(record, incomingBytes);
  return record;
}

/** Adopt actual converted source A, or exact inert raw M for incoming outputs, before generation. */
export function adoptRecoveryProtection(
  record: RecoveryProtection,
  actual: Buffer | null,
): RecoveryProtection {
  if (record.adopted) throw new Error('Recovery epoch already adopted');
  if (
    !actual &&
    (['modified', 'added'].includes(record.incoming) ||
      (record.incoming === 'unchanged' && record.localHash !== null))
  )
    throw new Error('Incoming or retained recovery index vanished');
  if (
    record.role === 'output' &&
    ['modified', 'added'].includes(record.incoming) &&
    bytesHash(actual) !== record.incomingHash
  )
    throw new Error('Incoming recovery output differs from pinned inert bytes');
  if (record.incoming === 'deleted' && actual)
    throw new Error('Deleted recovery index unexpectedly present');
  assertRecoveryRequirements(actual, record.requirements);
  return { ...addRequirement(record, actual), adopted: true };
}

/** Never weaken old sequences; publish the returned record durably before any dependent write. */
export function extendRecoveryProtection(
  record: RecoveryProtection,
  actual: Buffer | null,
): RecoveryProtection {
  if (!record.adopted) throw new Error('Recovery epoch not yet adopted');
  assertRecoveryRequirements(actual, record.requirements);
  return addRequirement(record, actual);
}

export interface RecoveryDirectoryIdentity {
  dev: string;
  ino: string;
  mode: string;
  uid: string;
  gid: string;
}

export interface RecoveryFileIdentity extends RecoveryDirectoryIdentity {
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  atimeNs: string;
}

export interface RecoveryFileObservation {
  path: string;
  identity: RecoveryFileIdentity | null;
  sha256: string | null;
  ancestors: { path: string; identity: RecoveryDirectoryIdentity }[];
  missingAncestor: string | null;
}

export interface RecoveryDataReference {
  file: string;
  sha256: string;
  bytes: number;
}

export interface RecoveryPathRecord {
  protection: RecoveryProtection;
  candidate: boolean;
  evidence: Partial<Record<'L' | 'H' | 'M' | 'B' | 'A' | 'G', RecoveryDataReference | null>>;
  original: RecoveryFileObservation;
  current: RecoveryFileObservation;
  eligibleAtMs: number;
}

export interface RecoveryInvocation {
  kind: 'syncRun';
  dryRun: false;
  push: true;
  integration: 'ff-only' | 'safe-merge';
  quietPeriodSeconds: number;
  cutoffMs: number;
}

type RecoveryEffectKind =
  | 'candidate'
  | 'generated'
  | 'rollback'
  | 'marker'
  | 'merge'
  | 'stage'
  | 'commit'
  | 'push';
type RecoveryPhase =
  | 'preparing'
  | 'prepared'
  | 'normalizing'
  | 'adopted'
  | 'generating'
  | 'resolving'
  | 'deferred'
  | 'complete'
  | 'resolved'
  | 'archive-pending'
  | 'archived';

export interface RecoveryIntent {
  id: string;
  kind: RecoveryEffectKind;
  status: 'pending' | 'complete' | 'reconciled';
  path: string | null;
  before: RecoveryFileObservation | null;
  proposed: RecoveryDataReference | null;
  after: RecoveryFileObservation | null;
  details: Record<string, string | number | boolean | string[]>;
}

export interface RecoveryOutcome {
  head: string;
  commits: string[];
  staged: string;
  push: 'not-attempted' | 'pushed' | 'failed' | 'uncertain';
  protectedVerified: true;
}

export interface RecoveryManifest {
  version: 1 | 2;
  transaction: string;
  generation: number;
  phase: RecoveryPhase;
  owner: SyncLockToken;
  root: string;
  gitDir: string;
  rootIdentity: RecoveryDirectoryIdentity;
  gitDirIdentity: RecoveryDirectoryIdentity;
  initial: RecoveryGitState;
  expected: RecoveryGitState;
  invocation: RecoveryInvocation;
  paths: RecoveryPathRecord[];
  markers: RecoveryFileObservation[];
  data: RecoveryDataReference[];
  privateDirectories: { path: string; identity: RecoveryDirectoryIdentity }[];
  resources: RecoveryResources;
  intents: RecoveryIntent[];
  relinquished: boolean;
  archiveName: string | null;
  outcome: RecoveryOutcome | null;
  resolvedBeforeMerge: boolean;
  attributeProofs: RecoveryDataReference[];
  checkout: { observedAtMs: number; opaqueHook: boolean } | null;
  observedInputs: string[];
  releasePrerequisite?: {
    protocol: 'owned-token-release-v1';
    transaction: string;
    generation: number;
    owner: SyncLockToken;
    kind: 'terminal' | 'deferred';
    location: string;
  } | null;
  preserved?: RecoveryDataReference[];
  manualResolution?: {
    sourceManifests: RecoveryDataReference[];
    reviews: ManualRecoveryReceipt[];
    captures: {
      reviewDigest: string;
      paths: ManualRecoveryCapture[];
      markers?: { observation: RecoveryFileObservation; bytes: RecoveryDataReference | null }[];
    }[];
  };
}

interface ManualRecoveryObject {
  mode: string;
  oid: string;
}

export interface ManualRecoveryPath {
  path: string;
  role: RecoveryProtection['role'];
  observation: RecoveryFileObservation;
  requirements: string[][];
  committed: ManualRecoveryObject | null;
  staged: ManualRecoveryObject | null;
}

export interface ManualRecoveryReceipt {
  version: 1;
  observationSemantics?: 'stable-no-atime';
  directory: string;
  transaction: string;
  generation: number;
  manifestSha256: string;
  inventorySha256: string;
  epoch: 'local' | 'incoming';
  state: RecoveryGitState;
  ordinaryLock?: SyncLockToken | null;
  ordinaryToken?: { sha256: string; identity: RecoveryFileIdentity } | null;
  ordinaryProcess?: { bootId: string; processStart: string } | null;
  arbitrationIdentity?: string;
  markers?: RecoveryFileObservation[];
  paths: ManualRecoveryPath[];
  observedInputs: string[];
  commits: string[];
  push: RecoveryOutcome['push'];
  digest: string;
}

interface ManualRecoveryCapture {
  path: string;
  worktree: RecoveryDataReference | null;
  committed: RecoveryDataReference | null;
  staged: RecoveryDataReference | null;
}

export interface ManualRecoveryReview {
  directory: string;
  manifest: RecoveryManifest;
  inventory: {
    files: { reference: RecoveryDataReference; identity: RecoveryFileIdentity }[];
    directories: { path: string; identity: RecoveryDirectoryIdentity }[];
    bytes: number;
    digest: string;
  };
  state: RecoveryGitState | null;
  ordinaryLock?: SyncLockToken | null;
  ordinaryProcess?: { bootId: string; processStart: string } | null;
  paths: ManualRecoveryPath[];
  markers: RecoveryFileObservation[];
  blockers: string[];
  operations: { description: string; argv: string[]; expectedSha256?: string; patch?: string }[];
  receipt: ManualRecoveryReceipt | null;
}

export interface RecoveryPersistenceHooks {
  boundary?(edge: string, path: string): Promise<void>;
  write?(handle: FileHandle, bytes: Buffer, offset: number): Promise<number>;
  close?(handle: FileHandle): Promise<void>;
  verifyGit?(state: RecoveryGitState): Promise<void>;
}

const JOURNAL_DIRECTORY = 'condash-index-recovery';
const MANIFEST_NAME = 'manifest.json';
const NONCE = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function directoryIdentity(stat: BigIntStats): RecoveryDirectoryIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
  };
}

function fileIdentity(stat: BigIntStats): RecoveryFileIdentity {
  return {
    ...directoryIdentity(stat),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    atimeNs: String(stat.atimeNs),
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameReference(left: RecoveryDataReference, right: RecoveryDataReference): boolean {
  return left.file === right.file && left.sha256 === right.sha256 && left.bytes === right.bytes;
}
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function nonce(): string {
  return randomBytes(16).toString('hex');
}

function stableFileIdentity(identity: RecoveryFileIdentity | null) {
  if (!identity) return null;
  const { atimeNs: _atime, ...stable } = identity;
  return stable;
}

function sameObservation(left: RecoveryFileObservation, right: RecoveryFileObservation): boolean {
  return same(
    { ...left, identity: stableFileIdentity(left.identity) },
    { ...right, identity: stableFileIdentity(right.identity) },
  );
}

function assertRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid recovery relative path');
}

async function optionalLstat(path: string): Promise<BigIntStats | null> {
  return fs.lstat(path, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

async function assertCaseSensitiveEntry(path: string, stat: BigIntStats): Promise<void> {
  const name = basename(path);
  const index = name.search(/[a-z]/i);
  if (index < 0) return;
  const letter = name[index];
  const alternate =
    name.slice(0, index) +
    (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()) +
    name.slice(index + 1);
  const alias = await optionalLstat(join(dirname(path), alternate));
  if (alias?.dev === stat.dev && alias.ino === stat.ino)
    throw new Error('Case-insensitive recovery path is unsupported');
}

async function checkedDirectory(
  path: string,
  privateMode = false,
  owned = true,
): Promise<RecoveryDirectoryIdentity> {
  const stat = await fs.lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    (owned && stat.uid !== BigInt(process.getuid!())) ||
    (privateMode && (Number(stat.mode) & 0o7777) !== 0o700) ||
    (await fs.realpath(path)) !== resolve(path)
  )
    throw new Error(`Unsafe recovery directory: ${JSON.stringify(path)}`);
  if (owned) await assertCaseSensitiveEntry(path, stat);
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const identity = directoryIdentity(stat);
    if (
      !same(directoryIdentity(await handle.stat({ bigint: true })), identity) ||
      !same(directoryIdentity(await fs.lstat(path, { bigint: true })), identity)
    )
      throw new Error('Recovery directory changed while opening');
    return identity;
  } finally {
    await handle.close();
  }
}

async function directoryChain(
  path: string,
): Promise<{ path: string; identity: RecoveryDirectoryIdentity }[]> {
  if (resolve(path) !== path) throw new Error('Unresolved recovery root');
  const root = parse(path).root;
  const systemUid = (await fs.lstat(root, { bigint: true })).uid;
  const result: { path: string; identity: RecoveryDirectoryIdentity }[] = [];
  let current = root;
  for (const part of ['', ...path.slice(root.length).split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = await fs.lstat(current, { bigint: true });
    if (
      (stat.uid !== BigInt(process.getuid!()) && stat.uid !== systemUid) ||
      (Number(stat.mode) & 0o002) !== 0
    )
      throw new Error('Foreign or writable recovery ancestor');
    result.push({ path: current, identity: await checkedDirectory(current, false, false) });
  }
  return result;
}

async function assertDirectories(
  directories: readonly { path: string; identity: RecoveryDirectoryIdentity }[],
): Promise<void> {
  for (const directory of directories) {
    const stat = await fs.lstat(directory.path, { bigint: true });
    if (!stat.isDirectory() || !same(directoryIdentity(stat), directory.identity))
      throw new Error('Recovery ancestor identity drift');
  }
}

async function boundedFile(
  path: string,
  maxBytes: number,
  privateMode = false,
): Promise<{ bytes: Buffer; identity: RecoveryFileIdentity }> {
  const stat = await fs.lstat(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(process.getuid!()) ||
    stat.size > BigInt(maxBytes) ||
    (privateMode && (Number(stat.mode) & 0o7777) !== 0o600)
  )
    throw new Error(`Unsupported recovery file: ${JSON.stringify(path)}`);
  await assertCaseSensitiveEntry(path, stat);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = fileIdentity(stat);
    if (
      !same(
        stableFileIdentity(fileIdentity(await handle.stat({ bigint: true }))),
        stableFileIdentity(identity),
      )
    )
      throw new Error('Recovery opened file identity drift');
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (
      size !== Number(stat.size) ||
      !same(
        stableFileIdentity(fileIdentity(await handle.stat({ bigint: true }))),
        stableFileIdentity(identity),
      ) ||
      !same(
        stableFileIdentity(fileIdentity(await fs.lstat(path, { bigint: true }))),
        stableFileIdentity(identity),
      )
    )
      throw new Error('Recovery file changed during read');
    return { bytes: bytes.subarray(0, size), identity };
  } finally {
    await handle.close();
  }
}

/** Observe only a relevant contained path, never a dependency or ignored-payload snapshot. */
export async function observeRecoveryFile(
  root: string,
  path: string,
  output = false,
): Promise<{ observation: RecoveryFileObservation; bytes: Buffer | null }> {
  assertRelativePath(path);
  const ancestors = await directoryChain(root);
  let current = root;
  for (const part of path.split('/').slice(0, -1)) {
    current = join(current, part);
    if (!(await optionalLstat(current)))
      return {
        observation: { path, identity: null, sha256: null, ancestors, missingAncestor: current },
        bytes: null,
      };
    if (await optionalLstat(join(current, '.git')))
      throw new Error('Nested Git ownership on recovery path');
    ancestors.push({ path: current, identity: await checkedDirectory(current) });
  }
  const absolute = join(root, path);
  if (!(await optionalLstat(absolute))) {
    await assertDirectories(ancestors);
    return {
      observation: { path, identity: null, sha256: null, ancestors, missingAncestor: null },
      bytes: null,
    };
  }
  const file = await boundedFile(absolute, RECOVERY_LIMITS.indexBytes);
  if (
    (Number(file.identity.mode) & 0o400) === 0 ||
    (output && (Number(file.identity.mode) & 0o7777) !== 0o644)
  )
    throw new Error('Unsupported recovery output/input mode');
  await assertDirectories(ancestors);
  return {
    observation: {
      path,
      identity: file.identity,
      sha256: bytesHash(file.bytes),
      ancestors,
      missingAncestor: null,
    },
    bytes: file.bytes,
  };
}

/** Validate the engine's actual input boundary without changing strategy parsing or ordinary reads. */
export async function validateRecoveryInput(
  root: string,
  input: IndexRecoveryInput,
): Promise<void> {
  const path = relative(root, input.path);
  if (input.kind === 'directory') {
    const chain = await directoryChain(root);
    if (path === '') {
      await assertDirectories(chain);
      return;
    }
    assertRelativePath(path);
    let current = root;
    for (const part of path.split('/')) {
      current = join(current, part);
      if (!(await optionalLstat(current))) return;
      if (await optionalLstat(join(current, '.git')))
        throw new Error('Nested Git ownership on recovery directory input');
      chain.push({ path: current, identity: await checkedDirectory(current) });
    }
    await assertDirectories(chain);
  } else {
    assertRelativePath(path);
    const actual = await observeRecoveryFile(root, path, input.kind === 'output');
    if (
      actual.bytes &&
      (input.kind === 'output' || path.endsWith('/index.md') || path === 'index.md')
    )
      recoveryLines(actual.bytes);
  }
}

/** Internal strict operations expose named before/after edges and narrow write/close fault injection. */
class RecoveryPersistence {
  constructor(
    readonly hooks: RecoveryPersistenceHooks,
    private readonly guard: () => Promise<void>,
  ) {}

  async step<T>(
    edge: string,
    path: string,
    operation: () => Promise<T>,
    mutation = true,
    cleanup?: (value: T) => Promise<void>,
  ): Promise<T> {
    await this.hooks.boundary?.(`${edge}:before`, path);
    if (mutation) await this.guard();
    const value = await operation();
    try {
      await this.hooks.boundary?.(`${edge}:after`, path);
    } catch (error) {
      if (cleanup) await cleanup(value).catch(() => {});
      throw error;
    }
    return value;
  }

  async syncDirectory(path: string, label: string): Promise<void> {
    const before = await checkedDirectory(path, false, false);
    const handle = await this.step(
      `${label}.open`,
      path,
      () => fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
      false,
      (handle) => handle.close(),
    );
    try {
      if (!same(directoryIdentity(await handle.stat({ bigint: true })), before))
        throw new Error('Directory fsync identity drift');
      await this.step(`${label}.fsync`, path, () => handle.sync());
    } finally {
      await this.close(handle, path, `${label}.close`);
    }
  }

  async createDirectory(path: string, label: string): Promise<RecoveryDirectoryIdentity> {
    await this.step(`${label}.mkdir`, path, () => fs.mkdir(path, { mode: 0o700 }));
    const identity = await checkedDirectory(path, true);
    await this.syncDirectory(path, `${label}.self`);
    await this.syncDirectory(dirname(path), `${label}.parent`);
    return identity;
  }

  async close(handle: FileHandle, path: string, label: string): Promise<void> {
    try {
      await this.step(
        label,
        path,
        () => (this.hooks.close ? this.hooks.close(handle) : handle.close()),
        false,
      );
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async exclusiveFile(
    path: string,
    bytes: Buffer,
    mode: number,
    label: string,
  ): Promise<RecoveryFileIdentity> {
    const handle = await this.step(
      `${label}.open`,
      path,
      () =>
        fs.open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      true,
      (handle) => handle.close(),
    );
    let identity: RecoveryFileIdentity | null = null;
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.uid !== BigInt(process.getuid!()) ||
        !same(directoryIdentity(opened), directoryIdentity(await fs.lstat(path, { bigint: true })))
      )
        throw new Error('Unsafe newly opened recovery file');
      await this.step(`${label}.chmod`, path, () => handle.chmod(mode));
      let offset = 0;
      while (offset < bytes.length) {
        const written = await this.step(`${label}.write`, path, async () =>
          this.hooks.write
            ? this.hooks.write(handle, bytes, offset)
            : (await handle.write(bytes, offset, bytes.length - offset, offset)).bytesWritten,
        );
        if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset)
          throw new Error('Invalid or zero recovery short write');
        offset += written;
      }
      await this.step(`${label}.fsync`, path, () => handle.sync());
      identity = fileIdentity(await handle.stat({ bigint: true }));
      if (
        !same(
          stableFileIdentity(identity),
          stableFileIdentity(fileIdentity(await fs.lstat(path, { bigint: true }))),
        )
      )
        throw new Error('Recovery publication temporary identity drift');
    } finally {
      await this.close(handle, path, `${label}.close`);
    }
    await this.syncDirectory(dirname(path), `${label}.parent`);
    const actual = await this.step(
      `${label}.verified`,
      path,
      () => boundedFile(path, bytes.length, mode === 0o600),
      false,
    );
    if (
      !actual.bytes.equals(bytes) ||
      !same(stableFileIdentity(actual.identity), stableFileIdentity(identity))
    )
      throw new Error('Recovery publication temporary changed');
    return actual.identity;
  }
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid recovery manifest object');
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0'))
    throw new Error('Invalid recovery manifest string');
}

function finiteValue(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Invalid recovery manifest number');
}

function arrayValue(value: unknown, limit = RECOVERY_LIMITS.entries): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error('Invalid recovery manifest array');
}

function validateDirectoryIdentity(value: unknown): void {
  const identity = plain(value);
  for (const key of ['dev', 'ino', 'mode', 'uid', 'gid']) {
    if (typeof identity[key] !== 'string' || !/^\d{1,32}$/.test(identity[key] as string))
      throw new Error('Invalid recovery identity');
  }
}

function validateFileIdentity(value: unknown): void {
  validateDirectoryIdentity(value);
  const identity = plain(value);
  for (const key of ['nlink', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs'])
    if (typeof identity[key] !== 'string' || !/^-?\d{1,32}$/.test(identity[key] as string))
      throw new Error('Invalid recovery file identity');
}

function validateObservation(value: unknown): void {
  const observation = plain(value);
  stringValue(observation.path);
  assertRelativePath(observation.path);
  if (observation.missingAncestor !== null) stringValue(observation.missingAncestor);
  arrayValue(observation.ancestors);
  for (const entry of observation.ancestors) {
    const ancestor = plain(entry);
    stringValue(ancestor.path);
    validateDirectoryIdentity(ancestor.identity);
  }
  if (observation.identity !== null) {
    validateDirectoryIdentity(observation.identity);
    const identity = plain(observation.identity);
    for (const key of ['nlink', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs'])
      if (typeof identity[key] !== 'string' || !/^-?\d{1,32}$/.test(identity[key] as string))
        throw new Error('Invalid recovery file identity');
    if (typeof observation.sha256 !== 'string' || !HASH.test(observation.sha256))
      throw new Error('Invalid recovery observed hash');
  } else if (observation.sha256 !== null) throw new Error('Hash on absent recovery path');
}

function validateDataReference(value: unknown, preserved = false): void {
  const reference = plain(value);
  stringValue(reference.file);
  assertRelativePath(reference.file);
  if (
    (!preserved && !reference.file.startsWith('data/')) ||
    reference.file === MANIFEST_NAME ||
    typeof reference.sha256 !== 'string' ||
    !HASH.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    (reference.bytes as number) < 0 ||
    (reference.bytes as number) >
      (preserved ? RECOVERY_LIMITS.journalBytes : RECOVERY_LIMITS.indexBytes)
  )
    throw new Error('Invalid recovery data reference');
}

function validateGitState(value: unknown): void {
  const state = plain(value);
  for (const key of [
    'root',
    'gitDir',
    'head',
    'branch',
    'upstream',
    'upstreamOid',
    'remote',
    'mergeRef',
    'pushRef',
    'pushRemote',
    'pushMergeRef',
  ])
    stringValue(state[key]);
  if (typeof state.staged !== 'string') throw new Error('Invalid structured staged recovery state');
  if (
    !OID.test(state.head as string) ||
    !OID.test(state.upstreamOid as string) ||
    !(state.branch as string).startsWith('refs/heads/') ||
    !(state.upstream as string).startsWith('refs/')
  )
    throw new Error('Invalid pinned recovery refs');
  for (const key of ['remoteUrls', 'pushUrls']) {
    arrayValue(state[key]);
    for (const url of state[key] as unknown[]) stringValue(url);
  }
  arrayValue(state.config);
  arrayValue(state.entries);
  for (const entry of state.config) {
    const config = plain(entry);
    for (const key of ['scope', 'origin', 'key', 'value']) stringValue(config[key]);
  }
  for (const entry of state.entries) {
    const stage = plain(entry);
    for (const key of ['path', 'mode', 'oid', 'flag', 'flags']) stringValue(stage[key]);
    if (
      stage.stage !== 0 ||
      !OID.test(stage.oid as string) ||
      !/^\d{6}$/.test(stage.mode as string)
    )
      throw new Error('Invalid recovery stage record');
  }
}

/** Validate the complete persisted shape before trusting a generation, never just its phase header. */
export function validateRecoveryManifest(value: unknown): RecoveryManifest {
  const record = plain(value);
  if (
    ![1, 2].includes(record.version as number) ||
    typeof record.transaction !== 'string' ||
    !NONCE.test(record.transaction) ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    ![
      'preparing',
      'prepared',
      'normalizing',
      'adopted',
      'generating',
      'resolving',
      'deferred',
      'complete',
      'resolved',
      'archive-pending',
      'archived',
    ].includes(record.phase as string)
  )
    throw new Error('Invalid recovery manifest version/generation/phase');
  for (const key of ['root', 'gitDir']) {
    stringValue(record[key]);
    if (resolve(record[key] as string) !== record[key]) throw new Error('Invalid recovery root');
  }
  const owner = plain(record.owner);
  for (const key of ['nonce', 'dev', 'ino', 'bootId', 'processStart', 'startedAt'])
    stringValue(owner[key]);
  if (
    !NONCE.test(owner.nonce as string) ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) < 1 ||
    !BOOT_ID.test(owner.bootId as string) ||
    !/^\d+$/.test(owner.processStart as string)
  )
    throw new Error('Invalid recovery owner');
  if (
    record.version === 2 &&
    record.phase !== 'resolving' &&
    (owner.version !== 2 ||
      owner.purpose !== 'recovery' ||
      owner.transaction !== record.transaction)
  )
    throw new Error('Invalid recovery-purpose manifest owner');
  if (record.version === 2) {
    const final = ['archived', 'deferred'].includes(record.phase as string);
    if (final) {
      const descriptor = plain(record.releasePrerequisite);
      if (
        descriptor.protocol !== 'owned-token-release-v1' ||
        descriptor.transaction !== record.transaction ||
        descriptor.generation !== record.generation ||
        !same(descriptor.owner, record.owner) ||
        descriptor.kind !== (record.phase === 'archived' ? 'terminal' : 'deferred') ||
        descriptor.location !==
          (record.phase === 'archived'
            ? join(
                record.gitDir as string,
                JOURNAL_DIRECTORY,
                'resolved',
                record.archiveName as string,
              )
            : join(record.gitDir as string, JOURNAL_DIRECTORY, 'active')) ||
        record.relinquished !== true
      )
        throw new Error('Invalid recovery release prerequisite descriptor');
    } else if (record.releasePrerequisite !== null)
      throw new Error('Nonfinal recovery retains a release descriptor');
  } else if (record.releasePrerequisite !== undefined && record.releasePrerequisite !== null)
    throw new Error('Legacy recovery cannot acknowledge publication');
  validateDirectoryIdentity(record.rootIdentity);
  validateDirectoryIdentity(record.gitDirIdentity);
  validateGitState(record.initial);
  validateGitState(record.expected);
  const invocation = plain(record.invocation);
  if (
    invocation.kind !== 'syncRun' ||
    invocation.dryRun !== false ||
    invocation.push !== true ||
    !['ff-only', 'safe-merge'].includes(invocation.integration as string)
  )
    throw new Error('Unsupported recovery invocation');
  finiteValue(invocation.quietPeriodSeconds);
  finiteValue(invocation.cutoffMs);
  if (invocation.quietPeriodSeconds < 0) throw new Error('Invalid recovery quiet cutoff');
  const resources = plain(record.resources);
  for (const key of ['entries', 'candidates', 'usedBytes', 'reservedBytes', 'emergencyUsedBytes'])
    if (!Number.isSafeInteger(resources[key]) || (resources[key] as number) < 0)
      throw new Error('Invalid retained recovery resources');
  new RecoveryBudget(undefined, resources as unknown as RecoveryResources);
  arrayValue(record.paths);
  arrayValue(record.markers);
  arrayValue(record.data);
  arrayValue(record.privateDirectories);
  arrayValue(record.intents);
  arrayValue(record.attributeProofs);
  arrayValue(record.observedInputs);
  const observedInputs = new Set<string>();
  for (const path of record.observedInputs) {
    stringValue(path);
    if (path !== '.') assertRelativePath(path);
    if (observedInputs.has(path)) throw new Error('Duplicate recovery input identity');
    observedInputs.add(path);
  }
  if (observedInputs.size > (resources.entries as number))
    throw new Error('Recovery input count exceeds retained resources');
  for (const proof of record.attributeProofs) validateDataReference(proof);
  const paths = new Set<string>();
  for (const value of record.paths) {
    const path = plain(value);
    const protection = plain(path.protection);
    stringValue(protection.path);
    assertRelativePath(protection.path);
    if (
      paths.has(protection.path) ||
      !['source', 'output'].includes(protection.role as string) ||
      !['unchanged', 'modified', 'added', 'deleted'].includes(protection.incoming as string) ||
      typeof protection.adopted !== 'boolean' ||
      typeof path.candidate !== 'boolean'
    )
      throw new Error('Invalid recovery path role');
    paths.add(protection.path);
    for (const key of ['localHash', 'incomingHash'])
      if (
        protection[key] !== null &&
        (typeof protection[key] !== 'string' || !HASH.test(protection[key] as string))
      )
        throw new Error('Invalid recovery epoch hash');
    arrayValue(protection.requirements);
    for (const sequence of protection.requirements) {
      arrayValue(sequence);
      for (const span of sequence) {
        stringValue(span);
        if (Buffer.from(span, 'base64').toString('base64') !== span)
          throw new Error('Invalid protected raw span');
      }
    }
    for (const [epoch, reference] of Object.entries(plain(path.evidence))) {
      if (!['L', 'H', 'M', 'B', 'A', 'G'].includes(epoch))
        throw new Error('Unknown recovery epoch');
      if (reference !== null) validateDataReference(reference);
    }
    validateObservation(path.original);
    validateObservation(path.current);
    finiteValue(path.eligibleAtMs);
  }
  for (const marker of record.markers) validateObservation(marker);
  const data = new Set<string>();
  for (const reference of record.data) {
    validateDataReference(reference);
    const file = (reference as RecoveryDataReference).file;
    if (data.has(file)) throw new Error('Duplicate recovery data identity');
    data.add(file);
  }
  if (record.preserved !== undefined) {
    arrayValue(record.preserved);
    for (const reference of record.preserved) {
      validateDataReference(reference, true);
      const file = (reference as RecoveryDataReference).file;
      if (data.has(file)) throw new Error('Duplicate preserved recovery evidence');
      data.add(file);
    }
  }
  for (const value of record.privateDirectories) {
    const directory = plain(value);
    stringValue(directory.path);
    assertRelativePath(directory.path);
    validateDirectoryIdentity(directory.identity);
  }
  for (const value of record.intents) {
    const intent = plain(value);
    if (
      typeof intent.id !== 'string' ||
      !NONCE.test(intent.id) ||
      ![
        'candidate',
        'generated',
        'rollback',
        'marker',
        'merge',
        'stage',
        'commit',
        'push',
      ].includes(intent.kind as string) ||
      !['pending', 'complete', 'reconciled'].includes(intent.status as string)
    )
      throw new Error('Invalid recovery effect intent');
    if (intent.path !== null) {
      stringValue(intent.path);
      assertRelativePath(intent.path);
    }
    if (intent.before !== null) validateObservation(intent.before);
    if (intent.after !== null) validateObservation(intent.after);
    if (intent.proposed !== null) validateDataReference(intent.proposed);
    for (const detail of Object.values(plain(intent.details))) {
      if (typeof detail === 'string') stringValue(detail);
      else if (typeof detail === 'number') finiteValue(detail);
      else if (typeof detail !== 'boolean') {
        arrayValue(detail);
        for (const item of detail) stringValue(item);
      }
    }
  }
  if (
    typeof record.relinquished !== 'boolean' ||
    typeof record.resolvedBeforeMerge !== 'boolean' ||
    (record.archiveName !== null &&
      (typeof record.archiveName !== 'string' || !NONCE.test(record.archiveName)))
  )
    throw new Error('Invalid recovery relinquishment/archive');
  if (record.outcome !== null) {
    const outcome = plain(record.outcome);
    stringValue(outcome.head);
    arrayValue(outcome.commits);
    if (typeof outcome.staged !== 'string')
      throw new Error('Invalid structured staged recovery outcome');
    if (
      !OID.test(outcome.head) ||
      outcome.protectedVerified !== true ||
      !['not-attempted', 'pushed', 'failed', 'uncertain'].includes(outcome.push as string)
    )
      throw new Error('Invalid recovery outcome');
    for (const oid of outcome.commits)
      if (typeof oid !== 'string' || !OID.test(oid))
        throw new Error('Invalid recovery commit outcome');
  }
  if (record.checkout !== null) {
    const checkout = plain(record.checkout);
    finiteValue(checkout.observedAtMs);
    if (typeof checkout.opaqueHook !== 'boolean')
      throw new Error('Invalid recovery checkout provenance');
  }
  if (record.manualResolution !== undefined) {
    const manual = plain(record.manualResolution);
    arrayValue(manual.sourceManifests);
    arrayValue(manual.reviews);
    arrayValue(manual.captures);
    for (const reference of manual.sourceManifests) validateDataReference(reference, true);
    for (const review of manual.reviews) validateManualReceipt(review);
    for (const entry of manual.captures) {
      const capture = plain(entry);
      stringValue(capture.reviewDigest);
      arrayValue(capture.paths);
      if (!HASH.test(capture.reviewDigest)) throw new Error('Invalid manual capture digest');
      for (const value of capture.paths) {
        const path = plain(value);
        stringValue(path.path);
        assertRelativePath(path.path);
        for (const key of ['worktree', 'committed', 'staged'])
          if (path[key] !== null) validateDataReference(path[key]);
      }
      if (capture.markers !== undefined) {
        arrayValue(capture.markers);
        for (const value of capture.markers) {
          const marker = plain(value);
          validateObservation(marker.observation);
          if (marker.bytes !== null) validateDataReference(marker.bytes);
        }
      }
    }
  }
  if (
    (record.intents as RecoveryIntent[]).some((intent) => intent.status === 'reconciled') &&
    record.manualResolution === undefined
  )
    throw new Error('Reconciled effects lack manual observation evidence');
  if (record.phase === 'deferred' && record.manualResolution !== undefined)
    throw new Error('Administrative resolution cannot become an automatic deferred claim');
  return value as RecoveryManifest;
}

function receiptDigest(
  receipt: Omit<ManualRecoveryReceipt, 'digest'> | ManualRecoveryReceipt,
): string {
  const { digest: _digest, ...facts } = receipt as ManualRecoveryReceipt;
  const canonical = clone(facts);
  if (canonical.observationSemantics === 'stable-no-atime') {
    for (const observation of [
      ...canonical.paths.map((path) => path.observation),
      ...(canonical.markers ?? []),
    ]) {
      if (observation.identity)
        delete (observation.identity as Partial<RecoveryFileIdentity>).atimeNs;
    }
    if (canonical.ordinaryToken)
      delete (canonical.ordinaryToken.identity as Partial<RecoveryFileIdentity>).atimeNs;
  }
  return bytesHash(Buffer.from(JSON.stringify(canonical)))!;
}

function validateManualReceipt(value: unknown): asserts value is ManualRecoveryReceipt {
  const receipt = plain(value);
  if (
    receipt.observationSemantics !== undefined &&
    receipt.observationSemantics !== 'stable-no-atime'
  )
    throw new Error('Unsupported manual observation semantics');
  if (
    receipt.version !== 1 ||
    !Number.isSafeInteger(receipt.generation) ||
    (receipt.generation as number) < 1 ||
    !['local', 'incoming'].includes(receipt.epoch as string)
  )
    throw new Error('Invalid manual recovery receipt');
  for (const key of ['directory', 'transaction', 'manifestSha256', 'inventorySha256', 'digest'])
    stringValue(receipt[key]);
  if (
    !NONCE.test(receipt.transaction as string) ||
    !HASH.test(receipt.manifestSha256 as string) ||
    !HASH.test(receipt.inventorySha256 as string) ||
    !HASH.test(receipt.digest as string)
  )
    throw new Error('Invalid manual receipt identity');
  validateGitState(receipt.state);
  arrayValue(receipt.paths);
  arrayValue(receipt.commits);
  arrayValue(receipt.observedInputs);
  if (receipt.ordinaryLock !== undefined && receipt.ordinaryLock !== null)
    validateManualHolder(receipt.ordinaryLock);
  if (receipt.ordinaryToken !== undefined && receipt.ordinaryToken !== null) {
    const token = plain(receipt.ordinaryToken);
    if (typeof token.sha256 !== 'string' || !HASH.test(token.sha256))
      throw new Error('Invalid reviewed token hash');
    validateFileIdentity(token.identity);
  }
  if (receipt.arbitrationIdentity !== undefined) stringValue(receipt.arbitrationIdentity);
  if (receipt.ordinaryProcess !== undefined && receipt.ordinaryProcess !== null) {
    const process = plain(receipt.ordinaryProcess);
    if (
      typeof process.bootId !== 'string' ||
      !BOOT_ID.test(process.bootId) ||
      typeof process.processStart !== 'string' ||
      !/^\d+$/.test(process.processStart)
    )
      throw new Error('Invalid reviewed process identity');
  }
  if (receipt.markers !== undefined) {
    arrayValue(receipt.markers);
    for (const marker of receipt.markers) {
      validateObservation(marker);
      if (!/^(projects|knowledge)\/\.index-dirty$/.test((marker as RecoveryFileObservation).path))
        throw new Error('Invalid manual marker path');
    }
  }
  for (const path of receipt.observedInputs) {
    stringValue(path);
    if (path !== '.') assertRelativePath(path);
  }
  if (new Set(receipt.observedInputs).size !== receipt.observedInputs.length)
    throw new Error('Duplicate manual input identity');
  for (const oid of receipt.commits)
    if (typeof oid !== 'string' || !OID.test(oid))
      throw new Error('Invalid observed manual commit');
  for (const value of receipt.paths) {
    const path = plain(value);
    stringValue(path.path);
    assertRelativePath(path.path);
    validateObservation(path.observation);
    arrayValue(path.requirements);
    if (!['source', 'output'].includes(path.role as string))
      throw new Error('Invalid manual path role');
    for (const sequence of path.requirements) {
      arrayValue(sequence);
      for (const span of sequence) {
        stringValue(span);
        if (Buffer.from(span, 'base64').toString('base64') !== span)
          throw new Error('Invalid manual protected span');
      }
    }
    for (const key of ['committed', 'staged'])
      if (path[key] !== null) {
        const object = plain(path[key]);
        if (object.mode !== '100644' || typeof object.oid !== 'string' || !OID.test(object.oid))
          throw new Error('Invalid manual object proof');
      }
  }
  if (
    !['not-attempted', 'pushed', 'failed', 'uncertain'].includes(receipt.push as string) ||
    receiptDigest(receipt as unknown as ManualRecoveryReceipt) !== receipt.digest
  )
    throw new Error('Manual receipt digest mismatch');
}

function validateManualHolder(value: unknown): asserts value is SyncLockToken {
  const holder = plain(value);
  for (const key of ['nonce', 'dev', 'ino', 'bootId', 'processStart', 'startedAt'])
    stringValue(holder[key]);
  if (
    !NONCE.test(holder.nonce as string) ||
    !Number.isSafeInteger(holder.pid) ||
    (holder.pid as number) < 1 ||
    !/^\d+$/.test(holder.processStart as string) ||
    !/^\d+$/.test(holder.dev as string) ||
    !/^\d+$/.test(holder.ino as string) ||
    !BOOT_ID.test(holder.bootId as string) ||
    !Number.isFinite(Date.parse(holder.startedAt as string))
  )
    throw new Error('Unprovable administrative ordinary holder');
}

/** Read and verify retained private evidence; errors and incomplete publications remain manual evidence. */
export async function readRecoveryManifest(directory: string): Promise<RecoveryManifest> {
  const activeIdentity = await checkedDirectory(directory, true);
  const file = await boundedFile(
    join(directory, MANIFEST_NAME),
    RECOVERY_LIMITS.journalBytes,
    true,
  );
  const text = file.bytes.toString('utf8');
  if (!Buffer.from(text).equals(file.bytes)) throw new Error('Invalid recovery manifest UTF-8');
  const record = validateRecoveryManifest(JSON.parse(text));
  if (
    directory !== join(record.gitDir, JOURNAL_DIRECTORY, 'active') &&
    directory !== join(record.gitDir, JOURNAL_DIRECTORY, 'resolved', record.archiveName ?? '')
  )
    throw new Error('Recovery manifest location drift');
  await directoryChain(record.root);
  await directoryChain(record.gitDir);
  if (
    !same(await checkedDirectory(record.root), record.rootIdentity) ||
    !same(await checkedDirectory(record.gitDir), record.gitDirIdentity)
  )
    throw new Error('Recovery root identity drift');
  const expectedFiles = new Map(
    [...record.data, ...(record.preserved ?? [])].map((reference) => [reference.file, reference]),
  );
  const directories = new Map(
    record.privateDirectories.map((directory) => [directory.path, directory.identity]),
  );
  if (!directories.has('data') || directories.size !== record.privateDirectories.length)
    throw new Error('Invalid recovery private directory inventory');
  let bytes = file.bytes.length;
  if (bytes > record.resources.usedBytes)
    throw new Error('Recovery manifest exceeds retained byte inventory');
  let entries = 0;
  const found = new Set<string>();
  async function walk(absolute: string, prefix: string): Promise<void> {
    const identity = await checkedDirectory(absolute, true);
    if (prefix && !same(directories.get(prefix), identity))
      throw new Error('Recovery private directory drift');
    for await (const entry of await fs.opendir(absolute)) {
      if (++entries > RECOVERY_LIMITS.entries)
        throw new Error('Recovery inventory entry limit exceeded');
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (path === MANIFEST_NAME) continue;
      if (directories.has(path)) await walk(join(directory, path), path);
      else {
        const reference = expectedFiles.get(path);
        if (!reference)
          throw new Error(`Unresolved or unexpected recovery evidence: ${JSON.stringify(path)}`);
        const stat = await fs.lstat(join(directory, path), { bigint: true });
        if (
          stat.size > BigInt(reference.bytes) ||
          bytes + Number(stat.size) > record.resources.usedBytes
        )
          throw new Error('Recovery inventory byte limit exceeded');
        bytes += Number(stat.size);
        const saved = await boundedFile(join(directory, path), reference.bytes, true);
        if (saved.bytes.length !== reference.bytes || bytesHash(saved.bytes) !== reference.sha256)
          throw new Error('Retained recovery evidence changed');
        found.add(path);
      }
    }
    if (!same(await checkedDirectory(absolute, true), identity))
      throw new Error('Recovery inventory directory changed');
  }
  await walk(directory, '');
  if (bytes !== record.resources.usedBytes || record.resources.emergencyUsedBytes !== 0)
    throw new Error('Recovery retained resource inventory drift');
  if (
    found.size !== expectedFiles.size ||
    !same(await checkedDirectory(directory, true), activeIdentity)
  )
    throw new Error('Recovery inventory is incomplete');
  for (const path of record.paths) {
    for (const reference of Object.values(path.evidence))
      if (reference && !same(expectedFiles.get(reference.file), reference))
        throw new Error('Recovery path references unretained data');
  }
  for (const intent of record.intents)
    if (intent.proposed && !same(expectedFiles.get(intent.proposed.file), intent.proposed))
      throw new Error('Recovery intent references unretained data');
  for (const proof of record.attributeProofs)
    if (!same(expectedFiles.get(proof.file), proof))
      throw new Error('Recovery attributes reference unretained data');
  for (const reference of record.manualResolution?.sourceManifests ?? [])
    if (!same(expectedFiles.get(reference.file), reference))
      throw new Error('Manual source manifest is not retained');
  for (const capture of record.manualResolution?.captures ?? [])
    for (const path of capture.paths)
      for (const reference of [path.worktree, path.committed, path.staged])
        if (reference && !same(expectedFiles.get(reference.file), reference))
          throw new Error('Manual captured representation is not retained');
  for (const capture of record.manualResolution?.captures ?? [])
    for (const marker of capture.markers ?? [])
      if (marker.bytes && !same(expectedFiles.get(marker.bytes.file), marker.bytes))
        throw new Error('Manual marker bytes are not retained');
  const current = await boundedFile(
    join(directory, MANIFEST_NAME),
    RECOVERY_LIMITS.journalBytes,
    true,
  );
  if (
    !current.bytes.equals(file.bytes) ||
    !same(stableFileIdentity(current.identity), stableFileIdentity(file.identity))
  )
    throw new Error('Recovery manifest changed during inventory');
  return record;
}

async function manualInventory(directory: string): Promise<{
  record: RecoveryManifest;
  manifestFile: Awaited<ReturnType<typeof boundedFile>>;
  inventory: ManualRecoveryReview['inventory'];
}> {
  const identity = await checkedDirectory(directory, true);
  const manifestFile = await boundedFile(
    join(directory, MANIFEST_NAME),
    RECOVERY_LIMITS.journalBytes,
    true,
  );
  const text = manifestFile.bytes.toString('utf8');
  if (!Buffer.from(text).equals(manifestFile.bytes))
    throw new Error('Manual recovery manifest is not round-trippable UTF-8');
  const record = validateRecoveryManifest(JSON.parse(text));
  if (
    directory !== join(record.gitDir, JOURNAL_DIRECTORY, 'active') &&
    directory !== join(record.gitDir, JOURNAL_DIRECTORY, 'resolved', record.archiveName ?? '')
  )
    throw new Error('Manual recovery location differs from its recorded root');
  await directoryChain(record.root);
  await directoryChain(record.gitDir);
  if (
    !same(await checkedDirectory(record.root), record.rootIdentity) ||
    !same(await checkedDirectory(record.gitDir), record.gitDirIdentity)
  )
    throw new Error('Manual recovery root identity drift');
  const knownFiles = new Map(
    [...record.data, ...(record.preserved ?? [])].map((reference) => [reference.file, reference]),
  );
  const knownDirectories = new Map(
    record.privateDirectories.map((entry) => [entry.path, entry.identity]),
  );
  const files: ManualRecoveryReview['inventory']['files'] = [];
  const directories: ManualRecoveryReview['inventory']['directories'] = [];
  const budget = new RecoveryBudget();
  let bytes = manifestFile.bytes.length;
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    budget.checkPreflight();
    const before = await checkedDirectory(absolute, true);
    if (prefix) {
      const known = knownDirectories.get(prefix);
      if (known && !same(known, before))
        throw new Error('Recorded manual evidence directory changed');
      directories.push({ path: prefix, identity: before });
    }
    for await (const entry of await fs.opendir(absolute)) {
      budget.countEntries();
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (file === MANIFEST_NAME) continue;
      const path = join(directory, file);
      const stat = await fs.lstat(path, { bigint: true });
      if (stat.isDirectory()) await walk(path, file);
      else {
        if (
          stat.size > BigInt(RECOVERY_LIMITS.journalBytes) ||
          bytes + Number(stat.size) > RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes
        )
          throw new Error('Manual evidence exceeds the retained journal quota');
        bytes += Number(stat.size);
        const saved = await boundedFile(path, Number(stat.size), true);
        const reference = { file, sha256: bytesHash(saved.bytes)!, bytes: saved.bytes.length };
        const known = knownFiles.get(file);
        if (known && !sameReference(reference, known))
          throw new Error('Known immutable recovery evidence changed');
        files.push({ reference: known ? clone(known) : reference, identity: saved.identity });
      }
    }
    if (!same(await checkedDirectory(absolute, true), before))
      throw new Error('Manual evidence directory changed during inspection');
  };
  await walk(directory, '');
  if (
    knownFiles.size &&
    [...knownFiles.keys()].some((file) => !files.some((entry) => entry.reference.file === file))
  )
    throw new Error('Known recovery evidence is missing');
  if (
    [...knownDirectories.keys()].some((path) => !directories.some((entry) => entry.path === path))
  )
    throw new Error('Known recovery evidence ancestor is missing');
  files.sort((left, right) => comparePaths(left.reference.file, right.reference.file));
  directories.sort((left, right) => comparePaths(left.path, right.path));
  const inventoryFacts = {
    files: files.map((entry) => ({
      reference: entry.reference,
      identity: stableFileIdentity(entry.identity),
    })),
    directories,
    manifestIdentity: stableFileIdentity(manifestFile.identity),
  };
  const current = await boundedFile(
    join(directory, MANIFEST_NAME),
    RECOVERY_LIMITS.journalBytes,
    true,
  );
  if (
    !current.bytes.equals(manifestFile.bytes) ||
    !same(stableFileIdentity(current.identity), stableFileIdentity(manifestFile.identity)) ||
    !same(await checkedDirectory(directory, true), identity)
  )
    throw new Error('Manual generation changed during inspection');
  return {
    record,
    manifestFile,
    inventory: {
      files,
      directories,
      bytes,
      digest: bytesHash(Buffer.from(JSON.stringify(inventoryFacts)))!,
    },
  };
}

async function manualGit(
  root: string,
  args: string[],
  maxBytes = RECOVERY_LIMITS.journalBytes,
): Promise<string> {
  return (
    await exec('git', ['--literal-pathspecs', '-C', root, ...args], {
      cwd: root,
      maxBuffer: maxBytes,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
  ).stdout;
}

async function isAncestor(root: string, ancestor: string, head: string): Promise<boolean> {
  if (!OID.test(ancestor) || !OID.test(head)) throw new Error('Invalid manual ancestry object ID');
  try {
    await manualGit(root, ['merge-base', '--is-ancestor', ancestor, head]);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function manualTreeObject(
  root: string,
  head: string,
  path: string,
): Promise<ManualRecoveryObject | null> {
  const raw = await manualGit(
    root,
    ['ls-tree', '-z', head, '--', path],
    RECOVERY_LIMITS.indexBytes,
  );
  if (!raw) return null;
  const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)\0$/.exec(raw);
  if (!match || match[3] !== path || !OID.test(match[2]))
    throw new Error('Unsupported manual committed output shape');
  return { mode: match[1], oid: match[2] };
}

async function manualSourceBytes(
  directory: string,
  inventory: ManualRecoveryReview['inventory'],
  reference: RecoveryDataReference,
): Promise<Buffer> {
  const known = inventory.files.find((entry) => entry.reference.file === reference.file);
  if (!known || !same(known.reference, reference))
    throw new Error('Unretained manual source reference');
  const file = await boundedFile(join(directory, reference.file), reference.bytes, true);
  if (
    bytesHash(file.bytes) !== reference.sha256 ||
    !same(stableFileIdentity(file.identity), stableFileIdentity(known.identity))
  )
    throw new Error('Manual source bytes changed');
  return file.bytes;
}

function addSequence(sequences: string[][], sequence: string[]): void {
  if (!sequences.some((known) => same(known, sequence))) sequences.push(sequence);
}

function assertManualObjectHash(bytes: Buffer, oid: string): void {
  const actual = createHash(oid.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (actual !== oid) throw new Error('Manual Git object bytes do not match their object ID');
}

/** Prepare concrete private review facts/operations only; this function never repairs, stages, commits or pushes. */
export async function inspectManualRecovery(options: {
  directory: string;
  reviewDirectory: string;
}): Promise<ManualRecoveryReview> {
  await checkedDirectory(options.reviewDirectory, true);
  const loaded = await manualInventory(options.directory);
  const { record, inventory, manifestFile } = loaded;
  if (
    options.reviewDirectory === record.root ||
    relative(record.root, options.reviewDirectory).split('/')[0] !== '..' ||
    options.reviewDirectory === options.directory ||
    !relative(options.directory, options.reviewDirectory).startsWith('../')
  )
    throw new Error('Manual review files must stay outside the worktree and recovery journal');
  const operations: ManualRecoveryReview['operations'] = [
    {
      description: 'Read attached identity without changing refs',
      argv: ['git', '-C', record.root, 'symbolic-ref', 'HEAD'],
    },
    {
      description: 'Read exact index entries and flags',
      argv: ['git', '-C', record.root, 'ls-files', '--stage', '-v', '-z'],
    },
  ];
  const report: ManualRecoveryReview = {
    directory: options.directory,
    manifest: record,
    inventory,
    state: null,
    paths: [],
    markers: [],
    blockers: [],
    operations,
    receipt: null,
  };
  const terminal =
    record.phase === 'archived' &&
    (await isResolvedRecoveryArchive(options.directory).catch(() => false));
  if (terminal)
    report.blockers.push(
      'This transaction already has a fully verified immutable terminal archive; no administrative rewrite is authorized.',
    );
  let state: RecoveryGitState;
  try {
    state = await readRecoveryGitState(
      record.root,
      { maxBytes: RECOVERY_LIMITS.journalBytes, maxEntries: RECOVERY_LIMITS.entries },
      { allowStaged: true },
    );
  } catch (error) {
    report.blockers.push(
      `Resolve the unsupported Git operation/index state first: ${String(error)}`,
    );
    return report;
  }
  report.state = state;
  if (
    (await manualGit(record.root, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])).trim()
  )
    report.blockers.push(
      'Git replacement refs make manual object/ancestry evidence uncertain; resolve that explicitly first.',
    );
  let canProposeRepairs = !terminal;
  let observedHolder: SyncLockToken | null = null;
  let observedToken: ManualRecoveryReceipt['ordinaryToken'] = null;
  const arbitrationStat = await fs.lstat(join(record.gitDir, 'condash-index-recovery.lock'), {
    bigint: true,
  });
  if (
    !arbitrationStat.isFile() ||
    arbitrationStat.nlink !== 1n ||
    arbitrationStat.uid !== BigInt(process.getuid!()) ||
    (Number(arbitrationStat.mode) & 0o7777) !== 0o600
  )
    throw new Error('Unsafe reviewed arbitration inode');
  const arbitrationIdentity = [
    arbitrationStat.dev,
    arbitrationStat.ino,
    arbitrationStat.mode,
    arbitrationStat.uid,
    arbitrationStat.nlink,
  ].join(':');
  const ordinaryLock = await optionalLstat(join(record.gitDir, 'condash-sync.lock'));
  report.ordinaryLock = null;
  report.ordinaryProcess = null;
  if (ordinaryLock) {
    const tokenFile = await boundedFile(join(record.gitDir, 'condash-sync.lock'), 4096, true);
    const holder = JSON.parse(tokenFile.bytes.toString('utf8'));
    observedToken = { sha256: bytesHash(tokenFile.bytes)!, identity: tokenFile.identity };
    await readSyncLockToken(record.gitDir);
    validateManualHolder(holder);
    if (holder.dev !== String(ordinaryLock.dev) || holder.ino !== String(ordinaryLock.ino))
      throw new Error('Administrative ordinary holder inode differs from its token');
    observedHolder = holder;
    const ownerIdentity = await readProcessIdentity(holder.pid);
    report.ordinaryLock = clone(holder);
    report.ordinaryProcess = ownerIdentity;
    if (
      ownerIdentity?.bootId === holder.bootId &&
      ownerIdentity.processStart === holder.processStart
    ) {
      canProposeRepairs = false;
      report.blockers.push(
        'The recorded ordinary owner is still live; wait for owned release or stop it through user-reviewed process control.',
      );
    }
  }
  const original = record.manualResolution?.sourceManifests[0]
    ? validateRecoveryManifest(
        JSON.parse(
          (
            await manualSourceBytes(
              options.directory,
              inventory,
              record.manualResolution.sourceManifests[0],
            )
          ).toString('utf8'),
        ),
      )
    : record;
  if (
    original.transaction !== record.transaction ||
    original.root !== record.root ||
    original.gitDir !== record.gitDir ||
    !same(original.initial, record.initial)
  )
    throw new Error('Manual baseline belongs to another transaction or pinned epoch');
  if (record.manualResolution && original.generation >= record.generation)
    throw new Error('Manual baseline is not a retained earlier generation');
  const identity = (value: RecoveryGitState) => ({
    root: value.root,
    gitDir: value.gitDir,
    branch: value.branch,
    upstream: value.upstream,
    remote: value.remote,
    mergeRef: value.mergeRef,
    pushRef: value.pushRef,
    pushRemote: value.pushRemote,
    pushMergeRef: value.pushMergeRef,
    remoteUrls: value.remoteUrls,
    pushUrls: value.pushUrls,
  });
  if (!same(identity(state), identity(original.initial)))
    report.blockers.push(
      'Restore the reviewed full attached/upstream destination identity without discarding commits; configuration must then be re-inspected.',
    );
  const incoming = await isAncestor(record.root, original.initial.upstreamOid, state.head);
  const local = await isAncestor(record.root, original.initial.head, state.head);
  const epoch: ManualRecoveryReceipt['epoch'] = incoming ? 'incoming' : 'local';
  if (
    !incoming &&
    (!local || original.checkout !== null || original.paths.some((path) => path.protection.adopted))
  )
    report.blockers.push(
      'Current HEAD does not retain the recorded incoming lineage; no reverse merge or epoch rebaseline is authorized.',
    );
  const baseline = incoming ? original.initial.upstreamOid : original.initial.head;
  const rawCommits = await manualGit(record.root, [
    'rev-list',
    `--max-count=${RECOVERY_LIMITS.entries + 1}`,
    '--reverse',
    `${baseline}..${state.head}`,
  ]);
  const commits = rawCommits.trim() ? rawCommits.trim().split('\n') : [];
  if (commits.length > RECOVERY_LIMITS.entries || commits.some((oid) => !OID.test(oid)))
    throw new Error('Manual commit census exceeds limits');
  const selected = new Set(
    record.intents
      .filter((intent) => intent.kind === 'commit')
      .flatMap((intent) => (Array.isArray(intent.details.paths) ? intent.details.paths : [])),
  );
  const paths = new Map(record.paths.map((path) => [path.protection.path, path.protection.role]));
  const seen = new Set(record.observedInputs);
  const budget = new RecoveryBudget();
  let currentBytes = 0;
  const lifecycle = {
    validateInput: async (input: IndexRecoveryInput) => {
      const path = relative(record.root, input.path) || '.';
      if (!seen.has(path)) {
        budget.countEntries();
        seen.add(path);
      }
      await validateRecoveryInput(record.root, input);
    },
    applyOutput: async () => {
      throw new Error('Manual census must not generate');
    },
    applyMarker: async () => {
      throw new Error('Manual census must not change markers');
    },
  };
  for (const strategy of [projectsStrategy, knowledgeStrategy]) {
    const enumeration = await enumerateIndexPaths(record.root, strategy, lifecycle);
    for (const path of enumeration.outputs) {
      await lifecycle.validateInput({ path: join(record.root, path), kind: 'source' });
      if (!paths.has(path)) paths.set(path, 'output');
    }
    for (const path of enumeration.inputs) {
      await lifecycle.validateInput({
        path: join(record.root, path),
        kind: basename(path) === 'README.md' ? 'readme' : 'source',
      });
      if (basename(path) === 'index.md' && !paths.has(path)) paths.set(path, 'source');
    }
  }
  if (paths.size > RECOVERY_LIMITS.entries || seen.size > RECOVERY_LIMITS.entries)
    throw new Error('Manual relevant census exceeds limits');
  if (record.resources.entries + seen.size - record.observedInputs.length > RECOVERY_LIMITS.entries)
    report.blockers.push('Manual observations exceed the retained relevant-entry quota.');
  for (const [path, role] of [...paths].sort(([left], [right]) => comparePaths(left, right))) {
    budget.checkPreflight();
    const before = await optionalLstat(join(record.root, path));
    if (
      before &&
      (before.size > BigInt(RECOVERY_LIMITS.indexBytes) ||
        currentBytes + Number(before.size) > RECOVERY_LIMITS.journalBytes)
    )
      throw new Error('Manual worktree census byte limit exceeded');
    let actual: Awaited<ReturnType<typeof observeRecoveryFile>>;
    try {
      actual = await observeRecoveryFile(record.root, path, role === 'output');
    } catch (error) {
      if (role !== 'output') throw error;
      actual = await observeRecoveryFile(record.root, path, false);
      const mode = actual.observation.identity
        ? Number(actual.observation.identity.mode) & 0o7777
        : null;
      if (mode === null || mode === 0o644) throw error;
      report.blockers.push(
        `${JSON.stringify(path)} has disk mode ${mode.toString(8)}; output closure requires 0644.`,
      );
      if (canProposeRepairs)
        report.operations.push({
          description: `The user may restore supported permissions on this verified regular single-link output after reviewing its identity and SHA-256; no file bytes are replaced.`,
          argv: ['chmod', '0644', '--', join(record.root, path)],
          expectedSha256: actual.observation.sha256!,
        });
    }
    currentBytes += actual.bytes?.length ?? 0;
    const retained = record.paths.find((entry) => entry.protection.path === path);
    const requirements: string[][] = [];
    const unrecordedIncoming =
      !retained && epoch === 'incoming'
        ? await manualTreeObject(record.root, original.initial.upstreamOid, path)
        : null;
    if (unrecordedIncoming && role === 'output') {
      if (unrecordedIncoming.mode !== '100644')
        report.blockers.push(`${JSON.stringify(path)} has an unsupported incoming output mode.`);
      else
        addSequence(
          requirements,
          recoveryProtectedSpans(
            await readRecoveryBlob(record.root, unrecordedIncoming.oid, {
              maxBytes: RECOVERY_LIMITS.indexBytes,
              maxEntries: RECOVERY_LIMITS.entries,
            }),
          ),
        );
    }
    if (retained) {
      if (epoch === 'local' && retained.evidence.L)
        addSequence(
          requirements,
          recoveryProtectedSpans(
            await manualSourceBytes(options.directory, inventory, retained.evidence.L),
          ),
        );
      else
        for (const sequence of retained.protection.requirements)
          addSequence(requirements, [...sequence]);
      for (const prior of record.manualResolution?.reviews ?? [])
        for (const proof of prior.paths)
          if (proof.path === path)
            for (const sequence of proof.requirements) {
              if (
                prior.epoch === 'local' &&
                epoch === 'incoming' &&
                ['modified', 'added'].includes(retained.protection.incoming) &&
                retained.evidence.L
              ) {
                const superseded = recoveryProtectedSpans(
                  await manualSourceBytes(options.directory, inventory, retained.evidence.L),
                );
                let cursor = 0;
                const additions: string[] = [];
                for (const span of sequence) {
                  if (cursor < superseded.length && span === superseded[cursor]) cursor++;
                  else additions.push(span);
                }
                addSequence(requirements, additions);
              } else addSequence(requirements, [...sequence]);
            }
    }
    try {
      assertRecoveryRequirements(actual.bytes, requirements);
      if (
        !actual.observation.identity &&
        (unrecordedIncoming ||
          (retained &&
            (['modified', 'added'].includes(retained.protection.incoming) ||
              (retained.current.identity && retained.protection.incoming !== 'deleted'))))
      )
        throw new Error('Retained or incoming path vanished');
    } catch (error) {
      report.blockers.push(
        `${JSON.stringify(path)} requires user reconciliation: ${String(error)}`,
      );
    }
    if (actual.bytes) addSequence(requirements, recoveryProtectedSpans(actual.bytes));
    let committed: ManualRecoveryObject | null = null;
    let staged: ManualRecoveryObject | null = null;
    if (role === 'output') {
      const head = await manualTreeObject(record.root, state.head, path);
      const base = await manualTreeObject(record.root, baseline, path);
      const entry = state.entries.find((entry) => entry.path === path);
      if ((commits.length && selected.has(path)) || !same(head, base)) committed = head;
      if ((entry?.oid ?? null) !== (head?.oid ?? null))
        staged = entry ? { mode: entry.mode, oid: entry.oid } : null;
      if (commits.length && selected.has(path) && !committed)
        report.blockers.push(
          `${JSON.stringify(path)} is missing from the observed committed output.`,
        );
      if (!entry && head)
        report.blockers.push(
          `${JSON.stringify(path)} has a staged deletion; reconcile it without replaying a commit.`,
        );
      for (const [label, object] of [
        ['committed', committed],
        ['staged', staged],
      ] as const)
        if (object) {
          try {
            if (object.mode !== '100644') throw new Error('Unsupported output mode');
            const bytes = await readRecoveryBlob(record.root, object.oid, {
              maxBytes: RECOVERY_LIMITS.indexBytes,
              maxEntries: RECOVERY_LIMITS.entries,
            });
            assertManualObjectHash(bytes, object.oid);
            assertRecoveryRequirements(bytes, requirements);
          } catch (error) {
            report.blockers.push(
              `${JSON.stringify(path)} ${label} object needs a user-authored forward repair: ${String(error)}`,
            );
            report.operations.push({
              description: `Read the exact raw ${label} blob for ${JSON.stringify(path)} before reviewing conversion and a forward-only repair; no staging, commit or push is performed.`,
              argv: ['git', '-C', record.root, 'cat-file', 'blob', object.oid],
            });
          }
        }
    }
    report.paths.push({
      path,
      role,
      observation: actual.observation,
      requirements,
      committed,
      staged,
    });
    if (epoch === 'local' && retained?.candidate && retained.evidence.L && actual.bytes) {
      const owned = [...record.intents]
        .reverse()
        .find(
          (intent) =>
            intent.path === path && intent.kind === 'candidate' && intent.status === 'complete',
        );
      if (canProposeRepairs && owned?.after && sameObservation(actual.observation, owned.after)) {
        const originalBytes = await manualSourceBytes(
          options.directory,
          inventory,
          retained.evidence.L,
        );
        const savedHead = retained.evidence.H
          ? await manualSourceBytes(options.directory, inventory, retained.evidence.H)
          : null;
        const headObject = await manualTreeObject(record.root, record.initial.head, path);
        if (
          !savedHead ||
          !headObject ||
          headObject.mode !== '100644' ||
          !actual.bytes.equals(savedHead) ||
          owned.proposed?.sha256 !== bytesHash(savedHead) ||
          !recoveryCandidateQualifies(originalBytes, savedHead)
        )
          throw new Error('Manual restoration lacks exact qualified owned-H evidence');
        assertManualObjectHash(savedHead, headObject.oid);
        if (!actual.bytes.equals(originalBytes) && !/[\r\n\t]/.test(path)) {
          const { createTwoFilesPatch } = await import('diff');
          const patch = createTwoFilesPatch(
            `a/${path}`,
            `b/${path}`,
            actual.bytes.toString('utf8'),
            originalBytes.toString('utf8'),
            undefined,
            undefined,
            { timeout: 1000, maxEditLength: RECOVERY_LIMITS.entries },
          );
          const patchPath = join(
            options.reviewDirectory,
            `restore-${record.transaction}-${retained.original.sha256}.patch`,
          );
          if (patch) {
            report.operations.push({
              description: `Review this exact owned-B-to-L patch; current SHA-256 must remain ${actual.observation.sha256}. Write the supplied patch privately before running these user-only commands.`,
              argv: ['git', '-C', record.root, 'apply', '--check', '--', patchPath],
              expectedSha256: actual.observation.sha256!,
              patch,
            });
            report.operations.push({
              description:
                'Only after review and the check succeeds, the user may apply the exact patch; the program does not run it.',
              argv: ['git', '-C', record.root, 'apply', '--', patchPath],
            });
          } else
            report.operations.push({
              description:
                'The exact diff exceeded the bounded review budget. Inspect retained L and reconcile in your editor; no replacement command is authorized.',
              argv: ['sha256sum', '--', join(options.directory, retained.evidence.L.file)],
              expectedSha256: retained.evidence.L.sha256,
            });
          report.blockers.push(
            `${JSON.stringify(path)} is still owned B; review/restoring the saved L delta precedes unchanged closure.`,
          );
        }
      }
    }
  }
  for (const path of ['knowledge/.index-dirty', 'projects/.index-dirty']) {
    await lifecycle.validateInput({ path: join(record.root, path), kind: 'marker' });
    report.markers.push((await observeRecoveryFile(record.root, path)).observation);
  }
  for (const intent of record.intents) {
    const temporary = intent.details.temporary;
    if (typeof temporary !== 'string' || !temporary) continue;
    assertRelativePath(temporary);
    if (
      dirname(temporary) !== dirname(intent.path ?? '') ||
      !/^\.condash-recovery-[a-f0-9]{32}\.tmp$/.test(basename(temporary))
    )
      throw new Error('Unproven manual temporary location');
    if (await optionalLstat(join(record.root, temporary))) {
      const temporaryFile = await observeRecoveryFile(record.root, temporary);
      const temporaryMode = temporaryFile.observation.identity
        ? Number(temporaryFile.observation.identity.mode) & 0o7777
        : 0;
      if (![0o600, 0o644].includes(temporaryMode))
        throw new Error('Unsupported orphan temporary permissions');
      const destination = join(
        options.directory,
        'data',
        `manual-${intent.id}-${nonce()}.artifact`,
      );
      if (await optionalLstat(destination))
        throw new Error('Private review destination unexpectedly exists');
      if (canProposeRepairs) {
        report.operations.push({
          description:
            'After identity/hash review, the user may make this exact temporary private before moving it; never chmod a pre-existing destination.',
          argv: ['chmod', '0600', '--', join(record.root, temporary)],
          expectedSha256: temporaryFile.observation.sha256!,
        });
        report.operations.push({
          description:
            'Review and retain this exact orphan temporary inside the private journal; do not overwrite or treat an occupied destination as a directory.',
          argv: [
            'mv',
            '--no-target-directory',
            '--no-clobber',
            '--',
            join(record.root, temporary),
            destination,
          ],
          expectedSha256: temporaryFile.observation.sha256!,
        });
      }
      report.blockers.push(
        `Retain the leftover worktree temporary ${JSON.stringify(temporary)} before closing; it must not become an ordinary sync input.`,
      );
    }
  }
  const latest = await manualInventory(options.directory);
  if (
    latest.inventory.digest !== inventory.digest ||
    !latest.manifestFile.bytes.equals(manifestFile.bytes)
  )
    throw new Error('Manual evidence changed before receipt');
  await assertRecoveryGitState(record.root, state, {
    maxBytes: RECOVERY_LIMITS.journalBytes,
    maxEntries: RECOVERY_LIMITS.entries,
  });
  for (const path of report.paths)
    if (
      !sameObservation(
        (
          await observeRecoveryFile(
            record.root,
            path.path,
            path.role === 'output' && report.blockers.length === 0,
          )
        ).observation,
        path.observation,
      )
    )
      throw new Error('Manual worktree changed before receipt');
  for (const marker of report.markers)
    if (!sameObservation((await observeRecoveryFile(record.root, marker.path)).observation, marker))
      throw new Error('Manual marker changed before receipt');
  if (
    seen.size > RECOVERY_LIMITS.entries ||
    record.resources.entries + seen.size - record.observedInputs.length > RECOVERY_LIMITS.entries
  )
    report.blockers.push(
      'Manual marker/input observations exceed the retained relevant-entry quota.',
    );
  if (!report.blockers.length) {
    const facts: Omit<ManualRecoveryReceipt, 'digest'> = {
      version: 1,
      observationSemantics: 'stable-no-atime',
      directory: options.directory,
      transaction: record.transaction,
      generation: record.generation,
      manifestSha256: bytesHash(manifestFile.bytes)!,
      inventorySha256: inventory.digest,
      epoch,
      state,
      ordinaryLock: observedHolder,
      ordinaryToken: observedToken,
      ordinaryProcess: report.ordinaryProcess,
      arbitrationIdentity,
      markers: report.markers,
      paths: report.paths,
      observedInputs: [...seen].sort(),
      commits,
      push:
        record.outcome?.head === state.head
          ? record.outcome.push
          : record.intents.some((intent) => intent.kind === 'push')
            ? 'uncertain'
            : 'not-attempted',
    };
    report.receipt = { ...facts, digest: receiptDigest(facts) };
  }
  return report;
}

export interface RecoveryJournalOptions {
  root: string;
  gitDir: string;
  lock: SyncLock;
  lease: RecoveryLease;
  state: RecoveryGitState;
  invocation: RecoveryInvocation;
  hooks?: RecoveryPersistenceHooks;
  budget?: RecoveryBudget;
  /**
   * Read-only create-time checks the orchestrator already ran before the
   * ordinary lock's cleanup transferred. When present, `create` consumes them
   * instead of re-running the checks, because a second throwing pass after
   * `transferEvidence()` would leak the transferred lock again (round 2,
   * note 17). Absent (tests, direct callers) `create` runs them itself.
   */
  bootstrap?: RecoveryJournalBootstrap;
}

/**
 * Recovery's provably non-mutating create-time checks. The orchestrator runs
 * these BEFORE the ordinary lock's cleanup responsibility transfers, so a
 * failure here releases the ordinary lock normally instead of leaking it for
 * the stale window (whole-diff review note 14, SHOULD); `RecoveryJournal.create`
 * re-runs them first so the journal stays self-contained.
 */
export function assertRecoveryJournalPreconditions(
  options: Pick<RecoveryJournalOptions, 'root' | 'gitDir' | 'state' | 'lease' | 'lock'>,
): void {
  if ((0o666 & ~process.umask()) !== 0o644)
    throw new Error('Recovery requires a 0644 Git checkout umask');
  if (
    process.platform !== 'linux' ||
    options.root !== options.state.root ||
    options.gitDir !== options.state.gitDir ||
    options.lease.gitDir !== options.gitDir ||
    !options.lock.token.bootId ||
    !options.lock.token.processStart
  )
    throw new Error('Unsupported recovery journal root/owner');
}

export interface RecoveryJournalBootstrap {
  /** Ancestor identities captured for `assertDirectories` drift checks. */
  anchors: { path: string; identity: RecoveryDirectoryIdentity }[];
  rootIdentity: RecoveryDirectoryIdentity;
  gitDirIdentity: RecoveryDirectoryIdentity;
}

/** `RecoveryJournal.checkGit` without the instance: hook-wrapped, read-only. */
async function verifyRecoveryGitState(
  root: string,
  expected: RecoveryGitState,
  hooks: RecoveryPersistenceHooks | undefined,
): Promise<void> {
  if (hooks?.verifyGit) await hooks.verifyGit(expected);
  else
    await assertRecoveryGitState(root, expected, {
      maxBytes: RECOVERY_LIMITS.journalBytes,
      maxEntries: RECOVERY_LIMITS.entries,
    });
}

/**
 * The four throwing READ-ONLY create-time checks — `directoryChain` ×2,
 * `checkedDirectory` ×2, `checkGit` — in `create`'s original order. Each is
 * pure observation (lstat/realpath/read-only opens/git state reads; note 18).
 * The orchestrator calls this before `transferEvidence()` so no throwing
 * pre-evidence check can run after the ordinary lock's cleanup transferred;
 * `create` consumes the returned identities instead of observing twice.
 */
export async function prepareRecoveryJournalBootstrap(
  options: Pick<RecoveryJournalOptions, 'root' | 'gitDir' | 'state' | 'hooks'>,
): Promise<RecoveryJournalBootstrap> {
  const anchors = [
    ...(await directoryChain(options.root)),
    ...(await directoryChain(options.gitDir)),
  ];
  const rootIdentity = await checkedDirectory(options.root);
  const gitDirIdentity = await checkedDirectory(options.gitDir);
  await verifyRecoveryGitState(options.root, clone(options.state), options.hooks);
  return { anchors, rootIdentity, gitDirIdentity };
}

/** Recovery-only strict data/manifest/target protocol. Entry-point orchestration is intentionally absent. */
export class RecoveryJournal {
  private currentDirectory: string;
  private readonly persistence: RecoveryPersistence;
  private readonly anchors: { path: string; identity: RecoveryDirectoryIdentity }[] = [];
  private expectedManifest: { bytes: Buffer; identity: RecoveryFileIdentity } | null = null;
  private halted = false;
  private busy = false;
  private released = false;
  private removalAttempted = false;
  private completedPublication = 0;
  private cleanupUncertainty: string | null = null;
  private administrativeReceipt: ManualRecoveryReceipt | null = null;
  private preparationComplete = false;
  private observedInputs = new Set<string>();
  private record: RecoveryManifest;
  private readonly budget: RecoveryBudget;

  private constructor(
    private readonly options: Omit<RecoveryJournalOptions, 'lock'> & { lock: SyncLock | null },
    rootIdentity: RecoveryDirectoryIdentity,
    gitDirIdentity: RecoveryDirectoryIdentity,
    retained?: RecoveryManifest,
  ) {
    this.currentDirectory = join(options.gitDir, JOURNAL_DIRECTORY, 'active');
    this.budget = options.budget ?? new RecoveryBudget();
    this.record = retained
      ? clone(retained)
      : {
          version: 2,
          transaction: nonce(),
          generation: 1,
          phase: 'preparing',
          owner: clone(options.lock!.token),
          root: options.root,
          gitDir: options.gitDir,
          rootIdentity,
          gitDirIdentity,
          initial: clone(options.state),
          expected: clone(options.state),
          invocation: clone(options.invocation),
          paths: [],
          markers: [],
          data: [],
          privateDirectories: [],
          resources: this.budget.snapshot(),
          intents: [],
          relinquished: false,
          archiveName: null,
          outcome: null,
          resolvedBeforeMerge: false,
          attributeProofs: [],
          checkout: null,
          observedInputs: [],
          releasePrerequisite: null,
        };
    this.persistence = new RecoveryPersistence(options.hooks ?? {}, () => this.assertOwner());
  }

  static async create(options: RecoveryJournalOptions): Promise<RecoveryJournal> {
    assertRecoveryJournalPreconditions(options);
    // With an orchestrator-provided bootstrap the four read-only create-time
    // checks already ran before the cleanup transfer; observing twice would
    // reintroduce a throwing pre-evidence check after `transferEvidence()`.
    const bootstrap = options.bootstrap ?? (await prepareRecoveryJournalBootstrap(options));
    const journal = new RecoveryJournal(options, bootstrap.rootIdentity, bootstrap.gitDirIdentity);
    journal.anchors.push(...bootstrap.anchors);
    retainRecoverySyncLock(options.lock);
    await journal.operation(async () => {
      const root = join(options.gitDir, JOURNAL_DIRECTORY);
      let rootIdentity: RecoveryDirectoryIdentity;
      if (await optionalLstat(root)) {
        if ((await inspectRecoveryEvidence(options.gitDir)).length)
          throw new Error('Existing recovery root requires discovery/reconciliation');
        rootIdentity = await checkedDirectory(root, true);
      } else rootIdentity = await journal.persistence.createDirectory(root, 'journal-root');
      journal.anchors.push({ path: root, identity: rootIdentity });
      const activeIdentity = await journal.persistence.createDirectory(
        journal.directory,
        'journal-active',
      );
      journal.anchors.push({ path: journal.directory, identity: activeIdentity });
      await persistRecoverySyncLock(
        options.lock,
        options.lease,
        journal.record.transaction,
        options.hooks,
      );
      journal.record.owner = clone(options.lock.token);
      validateRecoveryManifest(journal.record);
      const data = join(journal.directory, 'data');
      const dataIdentity = await journal.persistence.createDirectory(data, 'journal-data');
      journal.record.privateDirectories.push({ path: 'data', identity: dataIdentity });
      journal.anchors.push({ path: data, identity: dataIdentity });
      await journal.publish('manifest.prepare');
    });
    return journal;
  }

  snapshot(): RecoveryManifest {
    return clone(this.record);
  }
  get directory(): string {
    return this.currentDirectory;
  }
  get cleanupError(): string | null {
    return this.cleanupUncertainty;
  }

  async releaseForManualReconciliation(): Promise<void> {
    if (this.released) return;
    this.halted = true;
    await this.options.lease.close();
    this.released = true;
  }

  /** Close only a user-reviewed concrete inspection, after re-verifying all facts under administrative ownership. */
  static async resolveReviewed(options: {
    receipt: ManualRecoveryReceipt;
    reviewDirectory: string;
    hooks?: RecoveryPersistenceHooks;
  }): Promise<{ directory: string; outcome: RecoveryOutcome }> {
    validateManualReceipt(options.receipt);
    if (
      options.receipt.ordinaryToken === undefined ||
      options.receipt.ordinaryLock === undefined ||
      options.receipt.ordinaryProcess === undefined ||
      !options.receipt.arbitrationIdentity
    )
      throw new Error('Manual closure requires a fresh token/arbitration-bound inspection');
    let receipt = clone(options.receipt);
    const initialReview = await inspectManualRecovery({
      directory: receipt.directory,
      reviewDirectory: options.reviewDirectory,
    });
    if (!initialReview.receipt || initialReview.receipt.digest !== receipt.digest)
      throw new Error('Reviewed manual recovery facts changed; inspect and review again');
    const arbitrationStat = await fs.lstat(
      join(receipt.state.gitDir, 'condash-index-recovery.lock'),
      { bigint: true },
    );
    const arbitrationIdentity = [
      arbitrationStat.dev,
      arbitrationStat.ino,
      arbitrationStat.mode,
      arbitrationStat.uid,
      arbitrationStat.nlink,
    ].join(':');
    const arbitration = await acquireRecoveryLease(receipt.state.gitDir, {
      creation: 'existing-only',
    });
    if (arbitration.kind !== 'acquired')
      throw new Error(`Manual resolution arbitration ${arbitration.kind}`);
    let lock: SyncLock | null = null;
    let journal: RecoveryJournal | null = null;
    try {
      if (
        arbitration.lease.identity !== arbitrationIdentity ||
        arbitrationIdentity !== receipt.arbitrationIdentity
      )
        throw new Error('Reviewed arbitration inode changed');
      const review = await inspectManualRecovery({
        directory: receipt.directory,
        reviewDirectory: options.reviewDirectory,
      });
      if (!review.receipt || review.receipt.digest !== receipt.digest)
        throw new Error('Reviewed manual recovery facts changed; inspect and review again');
      receipt = clone(review.receipt);
      const originalManifest = await boundedFile(
        join(receipt.directory, MANIFEST_NAME),
        RECOVERY_LIMITS.journalBytes,
        true,
      );
      const known = new Set(review.manifest.data.map((reference) => reference.file));
      const preserved = review.inventory.files
        .filter((entry) => !known.has(entry.reference.file))
        .map((entry) => entry.reference);
      const headroom =
        RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes - review.inventory.bytes;
      const reservation =
        originalManifest.bytes.length * 3 +
        Buffer.byteLength(JSON.stringify(receipt)) * 2 +
        receipt.paths.reduce(
          (sum, path) =>
            sum + (path.observation.identity ? Number(path.observation.identity.size) : 0),
          0,
        );
      if (reservation > headroom)
        throw new Error(
          'Manual closure lacks bounded publication/evidence headroom; preserve the journal for explicit capacity reconciliation',
        );
      const { verifyGit: _unusedTestVerifier, ...persistenceHooks } = options.hooks ?? {};
      const budget = new RecoveryBudget(undefined, {
        ...review.manifest.resources,
        usedBytes: review.inventory.bytes,
        reservedBytes: 0,
        emergencyUsedBytes: 0,
      });
      journal = new RecoveryJournal(
        {
          root: receipt.state.root,
          gitDir: receipt.state.gitDir,
          lock,
          lease: arbitration.lease,
          state: receipt.state,
          invocation: review.manifest.invocation,
          budget,
          hooks: persistenceHooks,
        },
        review.manifest.rootIdentity,
        review.manifest.gitDirIdentity,
        review.manifest,
      );
      journal.currentDirectory = receipt.directory;
      journal.record = clone(review.manifest);
      journal.administrativeReceipt = clone(receipt);
      journal.record.version = 2;
      journal.record.expected = clone(receipt.state);
      journal.record.phase = 'resolving';
      journal.record.releasePrerequisite = null;
      journal.record.relinquished = false;
      journal.record.preserved = clone(preserved);
      journal.record.privateDirectories = clone(review.inventory.directories);
      journal.observedInputs = new Set(journal.record.observedInputs);
      journal.preparationComplete = true;
      journal.expectedManifest = originalManifest;
      journal.anchors.push(
        ...(await directoryChain(receipt.state.root)),
        ...(await directoryChain(receipt.state.gitDir)),
        {
          path: join(receipt.state.gitDir, JOURNAL_DIRECTORY),
          identity: await checkedDirectory(join(receipt.state.gitDir, JOURNAL_DIRECTORY), true),
        },
        { path: receipt.directory, identity: await checkedDirectory(receipt.directory, true) },
      );
      if (dirname(receipt.directory) !== join(receipt.state.gitDir, JOURNAL_DIRECTORY))
        journal.anchors.push({
          path: dirname(receipt.directory),
          identity: await checkedDirectory(dirname(receipt.directory), true),
        });
      for (const directory of review.inventory.directories)
        journal.anchors.push({
          path: join(receipt.directory, directory.path),
          identity: directory.identity,
        });
      const owner = journal;
      await owner.operation(async () => {
        for (const path of receipt.observedInputs) owner.countInput(path);
        await owner.options.hooks?.boundary?.('manual.before-claim', owner.directory);
        for (const entry of review.inventory.files) {
          const path = join(owner.directory, entry.reference.file);
          const actual = await boundedFile(path, entry.reference.bytes, true);
          if (
            !same(stableFileIdentity(actual.identity), stableFileIdentity(entry.identity)) ||
            bytesHash(actual.bytes) !== entry.reference.sha256
          )
            throw new Error('Reviewed private artifact changed before adoption');
          const handle = await owner.persistence.step(
            'manual.evidence.open',
            path,
            () => fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW),
            false,
            (handle) => handle.close(),
          );
          try {
            if (
              !same(
                stableFileIdentity(fileIdentity(await handle.stat({ bigint: true }))),
                stableFileIdentity(entry.identity),
              )
            )
              throw new Error('Manual artifact open identity drift');
            await owner.persistence.step('manual.evidence.fsync', path, () => handle.sync());
          } finally {
            await owner.persistence.close(handle, path, 'manual.evidence.close');
          }
          await owner.persistence.syncDirectory(dirname(path), 'manual.evidence-parent');
        }
        for (const directory of [...review.inventory.directories].sort(
          (left, right) => right.path.length - left.path.length,
        )) {
          await owner.persistence.syncDirectory(
            join(owner.directory, directory.path),
            'manual.directory',
          );
          await owner.persistence.syncDirectory(
            dirname(join(owner.directory, directory.path)),
            'manual.directory-parent',
          );
        }
        const source = await owner.storePreservedBytes(originalManifest.bytes);
        owner.record.manualResolution ??= { sourceManifests: [], reviews: [], captures: [] };
        owner.record.manualResolution.sourceManifests.push(source);
        owner.record.manualResolution.reviews.push(receipt);
        await owner.publish('manifest.manual-resolving');
        await owner.options.hooks?.boundary?.('manual.after-resolving', owner.directory);
        await owner.assertReviewedContent(receipt);
        lock = await acquireManualResolutionLock(
          receipt.state.gitDir,
          arbitration.lease,
          receipt.ordinaryLock ?? null,
          owner.record.transaction,
          async () => {
            await owner.assertOwner();
            if (
              owner.completedPublication !== owner.record.generation ||
              owner.record.phase !== 'resolving' ||
              owner.record.releasePrerequisite !== null
            )
              throw new Error('Administrative resolving barrier is not durably complete');
            await owner.assertReviewedContent(receipt);
          },
          persistenceHooks,
        );
        owner.options.lock = lock;
        owner.administrativeReceipt = null;
        owner.record.owner = clone(lock.token);
        await owner.publish('manifest.manual-claim');
        await owner.options.hooks?.boundary?.('manual.after-claim', owner.directory);
        await assertRecoveryGitState(receipt.state.root, receipt.state, {
          maxBytes: RECOVERY_LIMITS.journalBytes,
          maxEntries: RECOVERY_LIMITS.entries,
        });
        const captures: ManualRecoveryCapture[] = [];
        for (const path of receipt.paths) {
          const actual = await observeRecoveryFile(
            receipt.state.root,
            path.path,
            path.role === 'output',
          );
          if (!sameObservation(actual.observation, path.observation))
            throw new Error('Reviewed worktree changed before manual capture');
          assertRecoveryRequirements(actual.bytes, path.requirements);
          const worktree = await owner.storeData(actual.bytes);
          const capture: ManualRecoveryCapture = {
            path: path.path,
            worktree,
            committed: null,
            staged: null,
          };
          for (const label of ['committed', 'staged'] as const)
            if (path[label]) {
              const bytes = await readRecoveryBlob(receipt.state.root, path[label].oid, {
                maxBytes: RECOVERY_LIMITS.indexBytes,
                maxEntries: RECOVERY_LIMITS.entries,
              });
              assertRecoveryRequirements(bytes, path.requirements);
              assertManualObjectHash(bytes, path[label].oid);
              capture[label] = await owner.storeData(bytes);
            }
          captures.push(capture);
          const retained = owner.record.paths.find((entry) => entry.protection.path === path.path);
          if (retained) retained.current = actual.observation;
          else {
            owner.countInput(path.path);
            owner.record.paths.push({
              protection: {
                path: path.path,
                role: path.role,
                incoming: 'unchanged',
                adopted: true,
                localHash: actual.observation.sha256,
                incomingHash: null,
                requirements: clone(path.requirements),
              },
              candidate: false,
              evidence: { A: worktree },
              original: actual.observation,
              current: actual.observation,
              eligibleAtMs: Date.now(),
            });
          }
        }
        const markers = [];
        for (const marker of receipt.markers ?? []) {
          const actual = await observeRecoveryFile(receipt.state.root, marker.path);
          if (!sameObservation(actual.observation, marker))
            throw new Error('Reviewed manual marker changed before capture');
          markers.push({
            observation: actual.observation,
            bytes: await owner.storeData(actual.bytes),
          });
        }
        owner.record.markers = clone(receipt.markers ?? []);
        owner.record.manualResolution.captures.push({
          reviewDigest: receipt.digest,
          paths: captures,
          markers,
        });
        for (const intent of owner.record.intents)
          if (intent.status === 'pending') {
            intent.status = 'reconciled';
            intent.details.manualObservationDigest = receipt.digest;
          }
        owner.record.outcome = {
          head: receipt.state.head,
          commits: [...receipt.commits],
          staged: receipt.state.staged,
          push: receipt.push,
          protectedVerified: true,
        };
        owner.record.resolvedBeforeMerge = false;
        owner.record.phase = 'resolved';
        await assertRecoveryGitState(receipt.state.root, receipt.state, {
          maxBytes: RECOVERY_LIMITS.journalBytes,
          maxEntries: RECOVERY_LIMITS.entries,
        });
        for (const path of receipt.paths)
          if (
            !sameObservation(
              (await observeRecoveryFile(receipt.state.root, path.path, path.role === 'output'))
                .observation,
              path.observation,
            )
          )
            throw new Error('Reviewed manual path changed before resolution');
        for (const marker of receipt.markers ?? [])
          if (
            !sameObservation(
              (await observeRecoveryFile(receipt.state.root, marker.path)).observation,
              marker,
            )
          )
            throw new Error('Reviewed manual marker changed before resolution');
        if (
          (
            await manualGit(receipt.state.root, [
              'for-each-ref',
              '--format=%(refname)',
              'refs/replace/',
            ])
          ).trim()
        )
          throw new Error('Manual object resolution changed before publication');
        await owner.publish('manifest.manual-resolved');
        await owner.archiveAndRelease();
      });
      return { directory: journal.directory, outcome: clone(journal.record.outcome!) };
    } catch (error) {
      if (journal) await journal.releaseForManualReconciliation().catch(() => {});
      else {
        await arbitration.lease.close();
      }
      throw error;
    }
  }

  static async claim(options: {
    root: string;
    gitDir: string;
    generation: number;
    invocation: Omit<RecoveryInvocation, 'cutoffMs'>;
    hooks?: RecoveryPersistenceHooks;
  }): Promise<RecoveryJournal> {
    const arbitration = await acquireRecoveryLease(options.gitDir);
    if (arbitration.kind !== 'acquired')
      throw new Error(`Recovery claim arbitration ${arbitration.kind}`);
    let lock: SyncLock | null = null;
    let journal: RecoveryJournal | null = null;
    try {
      const directory = join(options.gitDir, JOURNAL_DIRECTORY, 'active');
      const record = await readRecoveryManifest(directory);
      const evidence = await inspectRecoveryEvidence(options.gitDir);
      if (
        evidence.length !== 1 ||
        evidence[0].path !== directory ||
        record.version !== 2 ||
        !record.releasePrerequisite ||
        (await readSyncLockToken(options.gitDir))
      )
        throw new Error(
          'Deferred claim requires one v2 generation and an absent publication token',
        );
      const originalManifest = await boundedFile(
        join(directory, MANIFEST_NAME),
        RECOVERY_LIMITS.journalBytes,
        true,
      );
      if (!same(JSON.parse(originalManifest.bytes.toString('utf8')), record))
        throw new Error('Deferred manifest changed during claim');
      if (
        record.phase !== 'deferred' ||
        record.relinquished !== true ||
        record.generation !== options.generation ||
        record.root !== options.root ||
        record.gitDir !== options.gitDir ||
        record.intents.some((intent) => intent.status === 'pending') ||
        record.paths.some((path) => !path.protection.adopted)
      )
        throw new Error('Recovery record is not an exact relinquished deferred generation');
      const invocation = {
        ...options.invocation,
        cutoffMs: Date.now() - options.invocation.quietPeriodSeconds * 1000,
      };
      if (
        !same(
          {
            ...invocation,
            quietPeriodSeconds: record.invocation.quietPeriodSeconds,
            cutoffMs: record.invocation.cutoffMs,
          },
          record.invocation,
        )
      )
        throw new Error('Deferred recovery invocation changed');
      validateRecoveryManifest({ ...record, invocation });
      const verify =
        options.hooks?.verifyGit ??
        ((state: RecoveryGitState) =>
          assertRecoveryGitState(options.root, state, {
            maxBytes: RECOVERY_LIMITS.journalBytes,
            maxEntries: RECOVERY_LIMITS.entries,
          }));
      await verify(record.expected);
      const observations = [];
      for (const path of record.paths) {
        const actual = await observeRecoveryFile(
          record.root,
          path.protection.path,
          path.protection.role === 'output',
        );
        assertRecoveryRequirements(actual.bytes, path.protection.requirements);
        if (path.current.identity && !actual.observation.identity)
          throw new Error('Deferred recovery path vanished');
        observations.push(actual);
      }
      await arbitration.lease.assertOwned();
      const latestManifest = await boundedFile(
        join(directory, MANIFEST_NAME),
        RECOVERY_LIMITS.journalBytes,
        true,
      );
      if (
        !latestManifest.bytes.equals(originalManifest.bytes) ||
        !same(
          stableFileIdentity(latestManifest.identity),
          stableFileIdentity(originalManifest.identity),
        )
      )
        throw new Error('Deferred generation drift before token acquisition');
      lock = await acquireDeferredSyncLock(
        options.gitDir,
        arbitration.lease,
        record.transaction,
        options.hooks,
      );
      journal = new RecoveryJournal(
        {
          root: options.root,
          gitDir: options.gitDir,
          lock,
          lease: arbitration.lease,
          state: record.expected,
          invocation,
          hooks: options.hooks,
          budget: new RecoveryBudget(undefined, record.resources),
        },
        record.rootIdentity,
        record.gitDirIdentity,
      );
      journal.record = clone(record);
      journal.observedInputs = new Set(record.observedInputs);
      journal.preparationComplete = true;
      journal.expectedManifest = originalManifest;
      journal.anchors.push(
        ...(await directoryChain(options.root)),
        ...(await directoryChain(options.gitDir)),
      );
      journal.anchors.push(
        {
          path: join(options.gitDir, JOURNAL_DIRECTORY),
          identity: await checkedDirectory(join(options.gitDir, JOURNAL_DIRECTORY), true),
        },
        { path: directory, identity: await checkedDirectory(directory, true) },
      );
      for (const privateDirectory of record.privateDirectories)
        journal.anchors.push({
          path: join(directory, privateDirectory.path),
          identity: privateDirectory.identity,
        });
      journal.record.owner = clone(lock.token);
      journal.record.invocation = invocation;
      journal.record.phase = 'generating';
      journal.record.relinquished = false;
      journal.record.releasePrerequisite = null;
      for (let index = 0; index < observations.length; index++) {
        const path = journal.record.paths[index];
        const actual = observations[index];
        path.protection = extendRecoveryProtection(path.protection, actual.bytes);
        if (!sameObservation(path.current, actual.observation)) path.eligibleAtMs = Date.now();
        path.current = actual.observation;
      }
      const owner = journal;
      await owner.operation(async () => {
        await options.hooks?.boundary?.('claim.before-publication', directory);
        await owner.publish('manifest.claim');
        await options.hooks?.boundary?.('claim.after-publication', directory);
        await owner.assertOwner();
        await owner.checkGit();
      });
      return journal;
    } catch (error) {
      await arbitration.lease.close();
      throw error;
    }
  }

  private async assertAdministrativeAuthority(): Promise<void> {
    const receipt = this.administrativeReceipt!;
    if (this.options.lease.identity !== receipt.arbitrationIdentity)
      throw new Error('Reviewed administrative arbitration changed');
    const token = await readSyncLockToken(this.record.gitDir);
    if (!same(token, receipt.ordinaryLock ?? null))
      throw new Error('Reviewed administrative token changed');
    if (token) {
      const file = await boundedFile(join(this.record.gitDir, 'condash-sync.lock'), 4096, true);
      if (
        bytesHash(file.bytes) !== receipt.ordinaryToken?.sha256 ||
        !same(stableFileIdentity(file.identity), stableFileIdentity(receipt.ordinaryToken.identity))
      )
        throw new Error('Reviewed administrative token bytes/stat changed');
      const process = await readProcessIdentity(token.pid);
      if (
        !same(process, receipt.ordinaryProcess ?? null) ||
        (process?.bootId === token.bootId && process.processStart === token.processStart)
      )
        throw new Error('Reviewed administrative process changed or remains live');
    }
  }

  private async assertReviewedContent(receipt: ManualRecoveryReceipt): Promise<void> {
    await assertRecoveryGitState(receipt.state.root, receipt.state, {
      maxBytes: RECOVERY_LIMITS.journalBytes,
      maxEntries: RECOVERY_LIMITS.entries,
    });
    for (const path of receipt.paths) {
      const actual = await observeRecoveryFile(
        receipt.state.root,
        path.path,
        path.role === 'output',
      );
      if (!sameObservation(actual.observation, path.observation))
        throw new Error('Reviewed content changed during administrative handoff');
      assertRecoveryRequirements(actual.bytes, path.requirements);
      for (const kind of ['staged', 'committed'] as const)
        if (path[kind]) {
          const bytes = await readRecoveryBlob(receipt.state.root, path[kind].oid, {
            maxBytes: RECOVERY_LIMITS.indexBytes,
            maxEntries: RECOVERY_LIMITS.entries,
          });
          assertManualObjectHash(bytes, path[kind].oid);
          assertRecoveryRequirements(bytes, path.requirements);
        }
    }
    for (const marker of receipt.markers ?? [])
      if (
        !sameObservation(
          (await observeRecoveryFile(receipt.state.root, marker.path)).observation,
          marker,
        )
      )
        throw new Error('Reviewed marker changed during administrative handoff');
  }

  private async assertOwner(): Promise<void> {
    if (!this.preparationComplete) this.budget.checkPreflight();
    await this.options.lease.assertOwned();
    if (this.administrativeReceipt) await this.assertAdministrativeAuthority();
    else {
      if (!this.options.lock) throw new Error('Recovery has no owned token');
      await this.options.lock.assertOwned();
      if (!same(this.record.owner, this.options.lock.token))
        throw new Error('Recovery manifest owner drift');
    }
    await assertDirectories(this.anchors);
    if (this.expectedManifest) {
      const current = await boundedFile(
        join(this.directory, MANIFEST_NAME),
        RECOVERY_LIMITS.journalBytes,
        true,
      );
      if (
        !same(
          stableFileIdentity(current.identity),
          stableFileIdentity(this.expectedManifest.identity),
        ) ||
        !current.bytes.equals(this.expectedManifest.bytes)
      )
        throw new Error('Recovery manifest generation/identity drift');
    }
  }

  private async checkGit(): Promise<void> {
    return verifyRecoveryGitState(this.options.root, this.record.expected, this.options.hooks);
  }

  private async operation<T>(body: () => Promise<T>): Promise<T> {
    if (this.halted || this.busy) throw new Error('Recovery journal is halted or busy');
    this.busy = true;
    try {
      await this.assertOwner();
      return await body();
    } catch (error) {
      this.halted = true;
      if (!this.removalAttempted) await this.recordFailure(error).catch(() => {});
      const failure = error instanceof Error ? error : new Error(String(error));
      Object.assign(failure, {
        recovery: {
          directory: this.directory,
          attemptedPhase: this.record.phase,
          observedGeneration: this.record.generation,
          expectedHead: this.record.expected.head,
          pendingIntents: this.record.intents.filter((intent) => intent.status === 'pending')
            .length,
        },
      });
      throw failure;
    } finally {
      this.busy = false;
    }
  }

  private allocate(bytes: number): void {
    const available = this.budget.snapshot().reservedBytes;
    if (available < bytes) this.budget.reserve(bytes - available);
    this.budget.consume(bytes);
  }

  private countInput(path: string): void {
    if (this.observedInputs.has(path)) return;
    if (this.preparationComplete) this.budget.countDynamicEntries();
    else this.budget.countEntries();
    this.observedInputs.add(path);
    this.record.observedInputs.push(path);
  }

  private async storeData(bytes: Buffer | null): Promise<RecoveryDataReference | null> {
    if (bytes === null) return null;
    this.budget.assertIndexBytes(bytes.length);
    const hash = bytesHash(bytes)!;
    const known = this.record.data.find(
      (entry) => entry.sha256 === hash && entry.bytes === bytes.length,
    );
    if (known) {
      await this.readData(known);
      return clone(known);
    }
    this.allocate(bytes.length);
    const reference = { file: `data/${nonce()}.bin`, sha256: hash, bytes: bytes.length };
    const path = join(this.directory, reference.file);
    await this.persistence.exclusiveFile(path, bytes, 0o600, 'data');
    const saved = await this.persistence.step(
      'data.readback',
      path,
      () => boundedFile(path, RECOVERY_LIMITS.indexBytes, true),
      false,
    );
    if (!saved.bytes.equals(bytes) || bytesHash(saved.bytes) !== reference.sha256)
      throw new Error('Recovery evidence readback mismatch');
    this.record.data.push(reference);
    return clone(reference);
  }

  private async storePreservedBytes(bytes: Buffer): Promise<RecoveryDataReference> {
    const hash = bytesHash(bytes)!;
    const known = [...this.record.data, ...(this.record.preserved ?? [])].find(
      (reference) => reference.sha256 === hash && reference.bytes === bytes.length,
    );
    if (known) return clone(known);
    if (bytes.length > RECOVERY_LIMITS.journalBytes)
      throw new Error('Preserved metadata exceeds journal bound');
    this.allocate(bytes.length);
    const reference = { file: `data/${nonce()}.metadata`, sha256: hash, bytes: bytes.length };
    await this.persistence.exclusiveFile(
      join(this.directory, reference.file),
      bytes,
      0o600,
      'manual.source-manifest',
    );
    this.record.preserved ??= [];
    this.record.preserved.push(reference);
    return reference;
  }

  private async readData(reference: RecoveryDataReference): Promise<Buffer> {
    validateDataReference(reference);
    if (!this.record.data.some((known) => same(known, reference)))
      throw new Error('Unrecorded recovery data reference');
    const file = await boundedFile(
      join(this.directory, reference.file),
      RECOVERY_LIMITS.indexBytes,
      true,
    );
    if (file.bytes.length !== reference.bytes || bytesHash(file.bytes) !== reference.sha256)
      throw new Error('Recovery evidence hash/size drift');
    return file.bytes;
  }

  private async publish(label: string): Promise<void> {
    const previousBytes = this.expectedManifest?.bytes.length ?? 0;
    const desired = clone(this.record);
    desired.generation = this.expectedManifest ? this.record.generation + 1 : 1;
    desired.releasePrerequisite =
      desired.version === 2 && ['archived', 'deferred'].includes(desired.phase)
        ? {
            protocol: 'owned-token-release-v1',
            transaction: desired.transaction,
            generation: desired.generation,
            owner: clone(desired.owner),
            kind: desired.phase === 'archived' ? 'terminal' : 'deferred',
            location: this.directory,
          }
        : null;
    let bytes = Buffer.alloc(0);
    for (let iteration = 0; iteration < 8; iteration++) {
      const resources = this.budget.snapshot();
      resources.usedBytes += bytes.length - previousBytes;
      resources.reservedBytes = Math.max(0, resources.reservedBytes - bytes.length);
      desired.resources = resources;
      const next = Buffer.from(JSON.stringify(desired) + '\n');
      if (next.length === bytes.length) {
        bytes = next;
        break;
      }
      bytes = next;
      if (iteration === 7) throw new Error('Unstable recovery manifest accounting');
    }
    if (bytes.length > RECOVERY_LIMITS.journalBytes - RECOVERY_LIMITS.emergencyBytes)
      throw new Error('Recovery manifest byte limit exceeded');
    validateRecoveryManifest(desired);
    this.allocate(bytes.length);
    const temporary = join(this.directory, `manifest-${nonce()}.tmp`);
    const temporaryIdentity = await this.persistence.exclusiveFile(temporary, bytes, 0o600, label);
    const destination = join(this.directory, MANIFEST_NAME);
    await this.persistence.step(`${label}.rename`, destination, async () => {
      if (!this.expectedManifest && (await optionalLstat(destination)))
        throw new Error('Unexpected initial recovery manifest');
      const proposed = await boundedFile(temporary, RECOVERY_LIMITS.journalBytes, true);
      if (
        !proposed.bytes.equals(bytes) ||
        !same(stableFileIdentity(proposed.identity), stableFileIdentity(temporaryIdentity))
      )
        throw new Error('Recovery manifest temporary changed before publication');
      await fs.rename(temporary, destination);
      const actual = await this.persistence.step(
        `${label}.readback`,
        destination,
        () => boundedFile(destination, RECOVERY_LIMITS.journalBytes, true),
        false,
      );
      if (!actual.bytes.equals(bytes)) throw new Error('Recovery manifest readback mismatch');
      this.expectedManifest = actual;
      this.record = desired;
    });
    await this.persistence.syncDirectory(this.directory, `${label}.published-parent`);
    this.budget.releaseReplacedManifest(previousBytes);
    if (!same(this.budget.snapshot(), this.record.resources))
      throw new Error('Recovery manifest resource drift');
    this.completedPublication = desired.generation;
  }

  async recordFailure(error: unknown): Promise<void> {
    this.halted = true;
    if (this.removalAttempted || this.released) return;
    const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        transaction: this.record.transaction,
        generation: this.record.generation,
        owner: clone(this.record.owner),
        phase: this.record.phase,
        error: String(error).slice(0, 4096),
      }) + '\n',
    );
    this.budget.consumeEmergency(bytes.length);
    await this.assertOwner();
    await this.persistence.exclusiveFile(
      join(this.directory, `error-${nonce()}.json`),
      bytes,
      0o600,
      'emergency-error',
    );
  }

  /** Capture only the approved bounded Git attribute helper's private artifacts under this journal. */
  async captureAttributeProof(
    maxAdditionalBytes: number,
    factory: (privateDirectory: string) => Promise<RecoveryAttributeProof>,
  ): Promise<RecoveryAttributeProof> {
    return this.operation(async () => {
      this.budget.reserve(maxAdditionalBytes);
      const usedBefore = this.budget.snapshot().usedBytes;
      const proof = await factory(join(this.directory, 'data'));
      await this.assertOwner();
      let count = 0;
      const collect = async (path: string, prefix: string): Promise<void> => {
        for await (const entry of await fs.opendir(path)) {
          if (++count > RECOVERY_LIMITS.entries)
            throw new Error('Recovery attribute artifact entry limit');
          const file = `${prefix}/${entry.name}`;
          if (this.record.data.some((reference) => reference.file === file)) continue;
          const absolute = join(this.directory, file);
          const stat = await fs.lstat(absolute, { bigint: true });
          if (stat.isDirectory()) {
            const identity = await checkedDirectory(absolute, true);
            const known = this.record.privateDirectories.find(
              (directory) => directory.path === file,
            );
            if (known && !same(known.identity, identity))
              throw new Error('Recovery attribute directory drift');
            if (!known) {
              await this.persistence.syncDirectory(absolute, 'attributes.directory');
              await this.persistence.syncDirectory(
                dirname(absolute),
                'attributes.directory-parent',
              );
              this.record.privateDirectories.push({ path: file, identity });
              this.anchors.push({ path: absolute, identity });
            }
            await collect(absolute, file);
          } else {
            const size = Number(stat.size);
            this.budget.assertIndexBytes(size);
            if (this.budget.snapshot().usedBytes - usedBefore + size > maxAdditionalBytes)
              throw new Error('Recovery attribute artifact reservation exceeded');
            this.allocate(size);
            const saved = await boundedFile(absolute, RECOVERY_LIMITS.indexBytes, true);
            const handle = await this.persistence.step(
              'attributes.file.open',
              absolute,
              () => fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW),
              false,
              (handle) => handle.close(),
            );
            try {
              if (
                !same(
                  stableFileIdentity(fileIdentity(await handle.stat({ bigint: true }))),
                  stableFileIdentity(saved.identity),
                )
              )
                throw new Error('Recovery attribute artifact identity drift');
              await this.persistence.step('attributes.file.fsync', absolute, () => handle.sync());
            } finally {
              await this.persistence.close(handle, absolute, 'attributes.file.close');
            }
            await this.persistence.syncDirectory(dirname(absolute), 'attributes.file-parent');
            this.record.data.push({
              file,
              bytes: saved.bytes.length,
              sha256: bytesHash(saved.bytes)!,
            });
          }
        }
      };
      await collect(join(this.directory, 'data'), 'data');
      const metadata = Buffer.from(JSON.stringify(proof) + '\n');
      if (this.budget.snapshot().usedBytes - usedBefore + metadata.length > maxAdditionalBytes)
        throw new Error('Recovery attribute metadata reservation exceeded');
      const reference = await this.storeData(metadata);
      this.record.attributeProofs.push(reference!);
      this.budget.releaseReservation(
        maxAdditionalBytes - (this.budget.snapshot().usedBytes - usedBefore),
      );
      await this.publish('manifest.attributes');
      return proof;
    });
  }

  async addPath(input: {
    path: string;
    role: RecoveryProtection['role'];
    incoming: RecoveryProtection['incoming'];
    head: Buffer | null;
    incomingBytes: Buffer | null;
    candidate?: boolean;
    eligibleAtMs: number;
  }): Promise<void> {
    for (const value of [input.head, input.incomingBytes])
      if (value) this.budget.assertIndexBytes(value.length);
    input = {
      ...input,
      head: input.head === null ? null : Buffer.from(input.head),
      incomingBytes: input.incomingBytes === null ? null : Buffer.from(input.incomingBytes),
    };
    await this.operation(async () => {
      const dynamic = ['adopted', 'generating'].includes(this.record.phase);
      if (
        (!dynamic && this.record.phase !== 'preparing') ||
        this.record.paths.some((path) => path.protection.path === input.path) ||
        (dynamic && input.candidate)
      )
        throw new Error('Recovery path already prepared or preparation ended');
      this.countInput(input.path);
      if (input.candidate) this.budget.countCandidate();
      const current = await observeRecoveryFile(
        this.record.root,
        input.path,
        input.role === 'output',
      );
      let protection = prepareRecoveryProtection(
        input.path,
        input.role,
        input.incoming,
        current.bytes,
        input.head,
        input.incomingBytes,
        input.candidate,
      );
      if (dynamic) protection = adoptRecoveryProtection(protection, current.bytes);
      const expectedSize = Math.max(
        current.bytes?.length ?? 0,
        input.head?.length ?? 0,
        input.incomingBytes?.length ?? 0,
      );
      this.budget.reserve(
        (current.bytes?.length ?? 0) +
          (input.head?.length ?? 0) +
          (input.incomingBytes?.length ?? 0) +
          3 * expectedSize +
          4096,
      );
      const local = await this.storeData(current.bytes);
      const head = await this.storeData(input.head);
      const incoming = await this.storeData(input.incomingBytes);
      this.record.paths.push({
        protection,
        candidate: input.candidate ?? false,
        evidence: {
          ...(dynamic ? { A: local } : { L: local }),
          H: head,
          M: incoming,
          ...(input.candidate ? { B: head } : {}),
        },
        original: current.observation,
        current: current.observation,
        eligibleAtMs: input.eligibleAtMs,
      });
      await this.publish('manifest.path');
    });
  }

  async prepare(): Promise<void> {
    await this.operation(async () => {
      if (this.record.phase !== 'preparing' || !this.record.paths.some((path) => path.candidate))
        throw new Error('Recovery preparation has no candidates');
      await this.checkGit();
      for (const path of this.record.paths) {
        const current = await observeRecoveryFile(
          this.record.root,
          path.protection.path,
          path.protection.role === 'output',
        );
        if (!sameObservation(current.observation, path.original))
          throw new Error('Recovery preparation input drift');
      }
      const futureBytes = this.record.paths.reduce(
        (total, path) =>
          total +
          3 *
            Math.max(
              path.original.identity ? Number(path.original.identity.size) : 0,
              path.evidence.H?.bytes ?? 0,
              path.evidence.M?.bytes ?? 0,
            ) +
          4096,
        2 * Buffer.byteLength(JSON.stringify(this.record)),
      );
      const reserved = this.budget.snapshot().reservedBytes;
      if (reserved < futureBytes) this.budget.reserve(futureBytes - reserved);
      this.record.phase = 'prepared';
      await this.publish('manifest.prepared');
      this.preparationComplete = true;
    });
  }

  private pathRecord(path: string): RecoveryPathRecord {
    const record = this.record.paths.find((record) => record.protection.path === path);
    if (!record) throw new Error('Path absent from retained recovery census');
    return record;
  }

  async promoteOutput(path: string, verifyInert: () => Promise<void>): Promise<void> {
    await this.operation(async () => {
      const record = this.pathRecord(path);
      const actual = await observeRecoveryFile(this.record.root, path, true);
      if (actual.bytes) recoveryLines(actual.bytes);
      if (
        ['modified', 'added'].includes(record.protection.incoming) &&
        actual.observation.sha256 !== record.protection.incomingHash
      )
        throw new Error('Converted source cannot become an incoming inert output');
      assertRecoveryRequirements(actual.bytes, record.protection.requirements);
      await verifyInert();
      record.protection.role = 'output';
      if (record.original.identity && this.record.checkout?.opaqueHook)
        record.eligibleAtMs = Math.max(record.eligibleAtMs, this.record.checkout.observedAtMs);
      await this.publish('manifest.output-role');
    });
  }

  async validateInput(input: IndexRecoveryInput): Promise<void> {
    await this.operation(async () => {
      const path = relative(this.record.root, input.path);
      if (path !== '' || input.kind !== 'directory') assertRelativePath(path);
      this.countInput(path || '.');
      await validateRecoveryInput(this.record.root, input);
      if (
        !['adopted', 'generating'].includes(this.record.phase) ||
        input.kind === 'directory' ||
        input.kind === 'marker' ||
        (input.kind !== 'output' && !path.endsWith('/index.md') && path !== 'index.md')
      )
        return;
      const record = this.pathRecord(path);
      if (input.kind === 'output' && record.protection.role !== 'output')
        throw new Error('Recovery source role must be promoted before output use');
      const actual = await observeRecoveryFile(
        this.record.root,
        path,
        record.protection.role === 'output',
      );
      if (record.current.identity && !actual.observation.identity)
        throw new Error('Retained recovery input vanished');
      const extended = extendRecoveryProtection(record.protection, actual.bytes);
      if (
        !same(extended, record.protection) ||
        !sameObservation(actual.observation, record.current)
      ) {
        record.protection = extended;
        record.current = actual.observation;
        record.eligibleAtMs = Date.now();
        await this.storeData(actual.bytes);
        await this.publish('manifest.input-protection');
      }
    });
  }

  private async persistTarget(
    path: string,
    before: RecoveryFileObservation,
    proposed: Buffer | null,
    kind: 'candidate' | 'generated' | 'rollback' | 'marker',
    restoredTime?: RecoveryFileIdentity,
    verifyInert?: () => Promise<void>,
  ): Promise<RecoveryFileObservation> {
    if (this.record.intents.some((intent) => intent.status === 'pending'))
      throw new Error('Unresolved recovery intent blocks further effects');
    await verifyInert?.();
    const currentBefore = await observeRecoveryFile(this.record.root, path, kind !== 'marker');
    if (!sameObservation(currentBefore.observation, before))
      throw new Error('Recovery target changed before intent');
    const beforeData = await this.storeData(currentBefore.bytes);
    const reference = await this.storeData(proposed);
    const temporaryPath =
      proposed === null ? '' : join(dirname(path), `.condash-recovery-${nonce()}.tmp`);
    const intent: RecoveryIntent = {
      id: nonce(),
      kind,
      status: 'pending',
      path,
      before: clone(before),
      proposed: reference,
      after: null,
      details: { beforeData: beforeData?.file ?? '', temporary: temporaryPath },
    };
    this.record.intents.push(intent);
    await this.publish(`manifest.${kind}-intent`);
    await this.checkGit();
    const absolute = join(this.record.root, path);
    if (before.missingAncestor) throw new Error('Recovery target parent is absent');
    const recheck = async () => {
      await this.assertOwner();
      const actual = await observeRecoveryFile(this.record.root, path, kind !== 'marker');
      if (!sameObservation(actual.observation, before))
        throw new Error('Recovery target changed before effect');
    };
    if (proposed === null) {
      if (kind !== 'marker') throw new Error('Only recovery markers can be unlinked');
      await recheck();
      if (before.identity)
        await this.persistence.step('target.unlink', absolute, async () => {
          await recheck();
          await fs.unlink(absolute);
        });
      await this.persistence.syncDirectory(dirname(absolute), 'target.parent');
    } else {
      const temporary = join(this.record.root, temporaryPath);
      const temporaryIdentity = await this.persistence.exclusiveFile(
        temporary,
        proposed,
        0o644,
        'target.temporary',
      );
      await this.checkGit();
      await this.persistence.step('target.rename', absolute, async () => {
        await recheck();
        await verifyInert?.();
        const saved = await boundedFile(temporary, RECOVERY_LIMITS.indexBytes);
        if (
          !saved.bytes.equals(proposed) ||
          !same(stableFileIdentity(saved.identity), stableFileIdentity(temporaryIdentity))
        )
          throw new Error('Recovery target temporary changed before rename');
        await this.assertOwner();
        await fs.rename(temporary, absolute);
      });
      const expected = await observeRecoveryFile(this.record.root, path, true);
      if (!expected.bytes?.equals(proposed))
        throw new Error('Recovery target rename readback mismatch');
      const handle = await this.persistence.step(
        'target.open',
        absolute,
        () => fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW),
        false,
        (handle) => handle.close(),
      );
      try {
        if (
          !same(
            stableFileIdentity(fileIdentity(await handle.stat({ bigint: true }))),
            stableFileIdentity(expected.observation.identity),
          )
        )
          throw new Error('Recovery renamed target identity drift');
        if (restoredTime)
          await this.persistence.step('target.utimes', absolute, () =>
            handle.utimes(Number(restoredTime.atimeNs) / 1e9, Number(restoredTime.mtimeNs) / 1e9),
          );
        await this.persistence.step('target.fsync', absolute, () => handle.sync());
      } finally {
        await this.persistence.close(handle, absolute, 'target.close');
      }
      await this.persistence.syncDirectory(dirname(absolute), 'target.parent');
    }
    const actual = await this.persistence.step(
      'target.readback',
      absolute,
      () => observeRecoveryFile(this.record.root, path, kind !== 'marker'),
      false,
    );
    if (
      (proposed === null ? actual.bytes !== null : !actual.bytes?.equals(proposed)) ||
      (restoredTime && actual.observation.identity?.mtimeNs !== restoredTime.mtimeNs)
    )
      throw new Error('Recovery target final bytes/mtime mismatch');
    const pending = this.record.intents.find((entry) => entry.id === intent.id)!;
    pending.after = actual.observation;
    pending.status = 'complete';
    const pathRecord = this.record.paths.find((entry) => entry.protection.path === path);
    if (pathRecord) pathRecord.current = actual.observation;
    else
      this.record.markers = [
        ...this.record.markers.filter((entry) => entry.path !== path),
        actual.observation,
      ];
    await this.publish(`manifest.${kind}-complete`);
    return actual.observation;
  }

  async normalizeCandidate(path: string, verifyInert: () => Promise<void>): Promise<void> {
    await this.operation(async () => {
      if (
        !['prepared', 'normalizing'].includes(this.record.phase) ||
        !same(this.record.initial, this.record.expected)
      )
        throw new Error('Candidate normalization is not pre-merge');
      const record = this.pathRecord(path);
      if (
        !record.candidate ||
        !record.evidence.H ||
        this.record.intents.some((intent) => intent.path === path && intent.kind === 'candidate')
      )
        throw new Error('Candidate is not eligible for normalization');
      this.record.phase = 'normalizing';
      await this.persistTarget(
        path,
        record.original,
        await this.readData(record.evidence.H),
        'candidate',
        undefined,
        verifyInert,
      );
    });
  }

  async rollbackCandidate(path: string, verifyInert: () => Promise<void>): Promise<void> {
    await this.operation(async () => {
      if (
        !['prepared', 'normalizing'].includes(this.record.phase) ||
        !same(this.record.initial, this.record.expected) ||
        this.record.intents.some((intent) =>
          ['merge', 'stage', 'commit', 'push'].includes(intent.kind),
        )
      )
        throw new Error('Recovery rollback is not provably pre-merge');
      const record = this.pathRecord(path);
      const owned = [...this.record.intents]
        .reverse()
        .find(
          (intent) =>
            intent.path === path && intent.kind === 'candidate' && intent.status === 'complete',
        );
      if (
        !record.candidate ||
        !record.evidence.L ||
        !record.evidence.B ||
        !record.original.identity ||
        !owned?.after ||
        owned.proposed?.sha256 !== record.evidence.B.sha256
      )
        throw new Error('No exact owned B rollback authority');
      const current = await observeRecoveryFile(this.record.root, path, true);
      if (!sameObservation(current.observation, owned.after))
        throw new Error('Owned B changed; manual reconciliation required');
      await this.persistTarget(
        path,
        owned.after,
        await this.readData(record.evidence.L),
        'rollback',
        record.original.identity,
        verifyInert,
      );
    });
  }

  async beginEffect(
    kind: 'merge' | 'stage' | 'commit' | 'push',
    details: RecoveryIntent['details'],
  ): Promise<string> {
    return this.operation(async () => {
      if (this.record.intents.some((intent) => intent.status === 'pending'))
        throw new Error('Unresolved recovery effect');
      if (
        kind === 'merge'
          ? !['prepared', 'normalizing'].includes(this.record.phase) ||
            this.record.intents.some((intent) => intent.kind === 'merge')
          : !['adopted', 'generating'].includes(this.record.phase)
      )
        throw new Error('Recovery effect phase is not eligible');
      await this.checkGit();
      if (kind !== 'merge') await this.census();
      const intent: RecoveryIntent = {
        id: nonce(),
        kind,
        status: 'pending',
        path: null,
        before: null,
        proposed: null,
        after: null,
        details: clone(details),
      };
      this.record.intents.push(intent);
      await this.publish(`manifest.${kind}-intent`);
      return intent.id;
    });
  }

  async completeEffect(id: string, expected: RecoveryGitState): Promise<void> {
    await this.operation(async () => {
      const intent = this.record.intents.find(
        (intent) => intent.id === id && intent.status === 'pending' && intent.path === null,
      );
      if (!intent) throw new Error('No pending external recovery effect');
      const stable = (state: RecoveryGitState) => {
        const {
          head: _head,
          entries: _entries,
          staged: _staged,
          upstreamOid: _upstream,
          ...identity
        } = state;
        return identity;
      };
      if (
        !same(stable(expected), stable(this.record.expected)) ||
        (intent.kind === 'merge' && expected.head !== this.record.initial.upstreamOid) ||
        (intent.kind !== 'push' && expected.upstreamOid !== this.record.expected.upstreamOid)
      )
        throw new Error('Unexpected external recovery identity transition');
      this.record.expected = clone(expected);
      await this.checkGit();
      intent.status = 'complete';
      await this.publish(`manifest.${intent.kind}-complete`);
    });
  }

  async adoptActual(checkout = { observedAtMs: Date.now(), opaqueHook: false }): Promise<void> {
    await this.operation(async () => {
      finiteValue(checkout.observedAtMs);
      if (
        this.record.expected.head !== this.record.initial.upstreamOid ||
        this.record.intents.some((intent) => intent.status === 'pending')
      )
        throw new Error('Recovery checkout cannot be adopted');
      await this.checkGit();
      for (const record of this.record.paths) {
        const actual = await observeRecoveryFile(
          this.record.root,
          record.protection.path,
          record.protection.role === 'output',
        );
        record.protection = adoptRecoveryProtection(record.protection, actual.bytes);
        if (
          record.protection.incoming === 'unchanged' &&
          !sameObservation(record.current, actual.observation)
        )
          record.eligibleAtMs = checkout.observedAtMs;
        record.evidence.A = await this.storeData(actual.bytes);
        record.current = actual.observation;
        if (record.original.identity && record.protection.role === 'output' && checkout.opaqueHook)
          record.eligibleAtMs = checkout.observedAtMs;
      }
      this.record.checkout = clone(checkout);
      this.record.phase = 'adopted';
      await this.publish('manifest.adopted');
    });
  }

  async applyOutput(
    path: string,
    input: Buffer | null,
    proposed: Buffer,
    verifyInert: () => Promise<void>,
  ): Promise<void> {
    this.budget.assertIndexBytes(proposed.length);
    proposed = Buffer.from(proposed);
    await this.operation(async () => {
      if (!['adopted', 'generating'].includes(this.record.phase))
        throw new Error('Recovery generation is not adopted');
      const record = this.pathRecord(path);
      if (record.protection.role !== 'output')
        throw new Error('Source-only recovery path cannot be written');
      const actual = await observeRecoveryFile(this.record.root, path, true);
      if (input === null ? actual.bytes !== null : !actual.bytes?.equals(input))
        throw new Error('Recovery render input drift');
      if (record.current.identity && !actual.observation.identity)
        throw new Error('Retained recovery output vanished');
      record.protection = extendRecoveryProtection(record.protection, actual.bytes);
      assertRecoveryRequirements(proposed, record.protection.requirements);
      await verifyInert();
      if (!sameObservation(actual.observation, record.current)) record.eligibleAtMs = Date.now();
      record.current = actual.observation;
      record.evidence.G = await this.storeData(proposed);
      this.record.phase = 'generating';
      await this.publish('manifest.protection');
      if (!actual.bytes?.equals(proposed))
        await this.persistTarget(
          path,
          actual.observation,
          proposed,
          'generated',
          undefined,
          verifyInert,
        );
    });
  }

  async applyMarker(path: string, input: Buffer | null, proposed: Buffer | null): Promise<void> {
    await this.operation(async () => {
      if (!/^(projects|knowledge)\/\.index-dirty$/.test(path))
        throw new Error('Invalid recovery dirty marker');
      const actual = await observeRecoveryFile(this.record.root, path);
      if (input === null ? actual.bytes !== null : !actual.bytes?.equals(input))
        throw new Error('Recovery marker drift');
      await this.persistTarget(path, actual.observation, proposed, 'marker');
    });
  }

  private async census(): Promise<void> {
    for (const path of this.record.paths) {
      const actual = await observeRecoveryFile(
        this.record.root,
        path.protection.path,
        path.protection.role === 'output',
      );
      if (path.current.identity && !actual.observation.identity)
        throw new Error('Required recovery path disappeared from census');
      path.protection = extendRecoveryProtection(path.protection, actual.bytes);
      if (!sameObservation(path.current, actual.observation)) path.eligibleAtMs = Date.now();
      path.current = actual.observation;
      await this.storeData(actual.bytes);
    }
  }

  /** Revalidate and retain the complete census at a caller's owned external-effect boundary. */
  async checkpoint(verify: () => Promise<void>): Promise<void> {
    await this.operation(async () => {
      await this.checkGit();
      await this.census();
      await verify();
      await this.publish('manifest.checkpoint');
    });
  }

  /** Bound a dynamically discovered raw object read before allocating its payload. */
  async readBlob(oid: string): Promise<Buffer> {
    return this.operation(async () => {
      let reserved = 0;
      try {
        return await readRecoveryBlob(
          this.record.root,
          oid,
          { maxBytes: RECOVERY_LIMITS.indexBytes, maxEntries: RECOVERY_LIMITS.entries },
          (size) => {
            this.budget.reserve(size);
            reserved = size;
          },
        );
      } finally {
        if (reserved) this.budget.releaseReservation(reserved);
      }
    });
  }

  async defer(): Promise<void> {
    await this.operation(async () => {
      if (
        !['adopted', 'generating'].includes(this.record.phase) ||
        this.record.intents.some(
          (intent) =>
            intent.status === 'pending' || ['stage', 'commit', 'push'].includes(intent.kind),
        )
      )
        throw new Error('Recovery cannot defer after unresolved or commit-capable effects');
      await this.checkGit();
      await this.census();
      for (const tree of new Set(
        this.record.paths
          .filter((path) => path.candidate)
          .map((path) => path.protection.path.split('/')[0]),
      )) {
        if (tree !== 'projects' && tree !== 'knowledge')
          throw new Error('Invalid recovered tree marker');
        const path = `${tree}/.index-dirty`;
        const marker = await observeRecoveryFile(this.record.root, path);
        await this.persistTarget(
          path,
          marker.observation,
          marker.bytes ?? Buffer.alloc(0),
          'marker',
        );
      }
      this.record.phase = 'deferred';
      this.record.relinquished = true;
      await this.publish('manifest.deferred');
      await readRecoveryManifest(this.directory);
      await this.checkGit();
      await this.assertOwner();
      await this.options.hooks?.boundary?.('deferred.before-release', this.directory);
      await this.acknowledgePublication();
    });
  }

  async finish(
    outcome: RecoveryOutcome,
    verifyOutcome: () => Promise<void>,
    resolved = false,
  ): Promise<void> {
    await this.operation(async () => {
      if (
        this.record.intents.some((intent) => intent.status === 'pending') ||
        this.record.paths.some((path) => !path.protection.adopted) ||
        outcome.head !== this.record.expected.head ||
        outcome.staged !== this.record.expected.staged
      )
        throw new Error('Recovery outcome is not reconciled');
      await this.checkGit();
      await this.census();
      await verifyOutcome();
      this.record.outcome = clone(outcome);
      this.record.phase = resolved ? 'resolved' : 'complete';
      await this.publish(`manifest.${this.record.phase}`);
      await this.archiveAndRelease();
    });
  }

  async resolveUnchanged(verifyUnchanged: () => Promise<void>): Promise<void> {
    await this.operation(async () => {
      if (
        !['preparing', 'prepared', 'normalizing'].includes(this.record.phase) ||
        !same(this.record.initial, this.record.expected) ||
        this.record.intents.some(
          (intent) =>
            intent.status === 'pending' || !['candidate', 'rollback'].includes(intent.kind),
        )
      )
        throw new Error('Recovery is not a provable unchanged pre-merge resolution');
      await this.checkGit();
      for (const path of this.record.paths) {
        const actual = await observeRecoveryFile(
          this.record.root,
          path.protection.path,
          path.protection.role === 'output',
        );
        const rollback = [...this.record.intents]
          .reverse()
          .find(
            (intent) =>
              intent.path === path.protection.path &&
              intent.kind === 'rollback' &&
              intent.status === 'complete',
          );
        if (
          actual.observation.sha256 !== path.original.sha256 ||
          (rollback?.after
            ? !sameObservation(actual.observation, rollback.after)
            : !sameObservation(actual.observation, path.original))
        )
          throw new Error('Pre-merge resolution has unexpected path effects');
      }
      await verifyUnchanged();
      this.record.resolvedBeforeMerge = true;
      this.record.outcome = {
        head: this.record.expected.head,
        commits: [],
        staged: this.record.expected.staged,
        push: 'not-attempted',
        protectedVerified: true,
      };
      this.record.phase = 'resolved';
      await this.publish('manifest.resolved');
      await this.archiveAndRelease();
    });
  }

  private async archiveAndRelease(): Promise<void> {
    const alreadyMoved = this.directory !== join(this.record.gitDir, JOURNAL_DIRECTORY, 'active');
    if (
      alreadyMoved &&
      this.directory !==
        join(this.record.gitDir, JOURNAL_DIRECTORY, 'resolved', this.record.archiveName ?? '')
    )
      throw new Error('Unproven manual archive location');
    if (!alreadyMoved) this.record.archiveName = nonce();
    if (!this.record.archiveName || !NONCE.test(this.record.archiveName))
      throw new Error('Invalid reviewed archive destination');
    this.record.phase = 'archive-pending';
    await this.publish('manifest.archive-pending');
    const root = join(this.record.gitDir, JOURNAL_DIRECTORY);
    const resolvedDirectory = join(root, 'resolved');
    const resolvedIdentity = (await optionalLstat(resolvedDirectory))
      ? await checkedDirectory(resolvedDirectory, true)
      : await this.persistence.createDirectory(resolvedDirectory, 'archive-root');
    this.anchors.push({ path: resolvedDirectory, identity: resolvedIdentity });
    const destination = join(resolvedDirectory, this.record.archiveName);
    const source = this.directory;
    if (!alreadyMoved)
      await this.persistence.step('archive.rename', destination, async () => {
        if (await optionalLstat(destination))
          throw new Error('Recovery archive destination already exists');
        // The exclusive lease serializes cooperating publishers; direct writers retain the disclosed final-check window.
        await fs.rename(source, destination);
        this.currentDirectory = destination;
        for (const anchor of this.anchors)
          if (anchor.path === source || anchor.path.startsWith(`${source}/`))
            anchor.path = destination + anchor.path.slice(source.length);
      });
    else
      await this.persistence.step(
        'archive.observed-location',
        destination,
        async () => {
          if (
            !same(await checkedDirectory(destination, true), await checkedDirectory(source, true))
          )
            throw new Error('Reviewed archive location changed');
        },
        false,
      );
    await this.persistence.syncDirectory(root, 'archive.source-parent');
    await this.persistence.syncDirectory(resolvedDirectory, 'archive.destination-parent');
    this.record.phase = 'archived';
    this.record.relinquished = true;
    await this.publish('manifest.archived');
    await this.persistence.step(
      'archive.terminal-verify',
      this.directory,
      async () => {
        if (!(await validateRecoveryArchiveContents(this.directory)))
          throw new Error('Recovery terminal archive did not verify');
      },
      false,
    );
    await this.checkGit();
    await this.assertOwner();
    await this.acknowledgePublication();
  }

  private async acknowledgePublication(): Promise<void> {
    const generation = this.completedPublication;
    if (
      !this.options.lock ||
      this.administrativeReceipt ||
      generation !== this.record.generation ||
      !this.record.releasePrerequisite
    )
      throw new Error('No completed exact-generation publication capability');
    this.cleanupUncertainty = await releaseRecoverySyncLock(
      this.options.lock,
      this.options.lease,
      async () => {
        if (generation !== this.record.generation || generation !== this.completedPublication)
          throw new Error('Publication generation changed before release');
        await this.assertOwner();
        const actual = await readRecoveryManifest(this.directory);
        if (!same(actual, this.record)) throw new Error('Final publication changed before release');
        await this.checkGit();
        const manual = this.record.manualResolution?.reviews.at(-1);
        if (manual) await this.assertReviewedContent(manual);
        else
          for (const path of this.record.paths) {
            const observed = await observeRecoveryFile(
              this.record.root,
              path.protection.path,
              path.protection.role === 'output',
            );
            if (!sameObservation(observed.observation, path.current))
              throw new Error('Final protected path identity changed before release');
            if (this.record.resolvedBeforeMerge) {
              if (observed.observation.sha256 !== path.original.sha256)
                throw new Error('Resolved local epoch changed before release');
            } else assertRecoveryRequirements(observed.bytes, path.protection.requirements);
          }
      },
      () => {
        this.removalAttempted = true;
      },
      this.options.hooks,
    );
    this.released = true;
    this.halted = true;
    try {
      await this.options.hooks?.boundary?.('token.release.helper:before', this.directory);
      await this.options.lease.assertOwned();
      await this.options.lease.close();
      await this.options.hooks?.boundary?.('token.release.helper:after', this.directory);
    } catch (error) {
      this.cleanupUncertainty = [this.cleanupUncertainty, String(error)].filter(Boolean).join('; ');
      await this.options.lease.close().catch(() => {});
    }
  }
}

/** Terminal discovery verifies the full immutable inventory, not a filename or phase-only header. */
export async function isResolvedRecoveryArchive(directory: string): Promise<boolean> {
  const record = await readRecoveryManifest(directory);
  if (record.version !== 2) return false;
  const token = await readSyncLockToken(record.gitDir);
  if (
    token &&
    (token.version !== 2 || token.purpose !== 'ordinary' || token.nonce === record.owner.nonce)
  )
    return false;
  return validateRecoveryArchiveContents(directory);
}

async function validateRecoveryArchiveContents(directory: string): Promise<boolean> {
  const record = await readRecoveryManifest(directory);
  if (record.manualResolution) return verifyManualArchive(directory, record);
  const epochs = record.resolvedBeforeMerge
    ? same(record.initial, record.expected) &&
      record.intents.every((intent) => ['candidate', 'rollback'].includes(intent.kind)) &&
      record.outcome?.push === 'not-attempted' &&
      record.outcome.commits.length === 0
    : record.paths.every((path) => path.protection.adopted);
  return (
    record.phase === 'archived' &&
    record.relinquished === true &&
    record.archiveName !== null &&
    directory === join(record.gitDir, JOURNAL_DIRECTORY, 'resolved', record.archiveName) &&
    record.outcome?.protectedVerified === true &&
    record.outcome.head === record.expected.head &&
    record.outcome.staged === record.expected.staged &&
    record.intents.every((intent) => intent.status === 'complete') &&
    epochs
  );
}

async function verifyManualArchive(directory: string, record: RecoveryManifest): Promise<boolean> {
  const manual = record.manualResolution!;
  const review = manual.reviews[manual.reviews.length - 1];
  const capture = manual.captures.find((capture) => capture.reviewDigest === review?.digest);
  if (
    record.phase !== 'archived' ||
    !record.relinquished ||
    directory !== join(record.gitDir, JOURNAL_DIRECTORY, 'resolved', record.archiveName ?? '') ||
    !review ||
    !capture ||
    !manual.sourceManifests.length ||
    !same(review.state, record.expected) ||
    record.outcome?.head !== review.state.head ||
    record.outcome.staged !== review.state.staged ||
    record.outcome.push !== review.push ||
    !same(record.outcome.commits, review.commits) ||
    record.intents.some((intent) => !['complete', 'reconciled'].includes(intent.status))
  )
    return false;
  const references = new Map(
    [...record.data, ...(record.preserved ?? [])].map((reference) => [reference.file, reference]),
  );
  const bytes = async (reference: RecoveryDataReference | null): Promise<Buffer | null> => {
    if (!reference) return null;
    if (!same(references.get(reference.file), reference))
      throw new Error('Unretained manual closure bytes');
    const file = await boundedFile(join(directory, reference.file), reference.bytes, true);
    if (bytesHash(file.bytes) !== reference.sha256) throw new Error('Manual closure bytes changed');
    return file.bytes;
  };
  const original = validateRecoveryManifest(
    JSON.parse((await bytes(manual.sourceManifests[0]))!.toString('utf8')),
  );
  if (
    original.transaction !== record.transaction ||
    original.root !== record.root ||
    original.gitDir !== record.gitDir ||
    review.transaction !== record.transaction ||
    review.paths.length !== capture.paths.length ||
    record.paths.some((path) => !review.paths.some((proof) => proof.path === path.protection.path))
  )
    return false;
  for (const proof of review.paths) {
    const saved = capture.paths.find((path) => path.path === proof.path);
    if (!saved) return false;
    const actual = await bytes(saved.worktree);
    if (bytesHash(actual) !== proof.observation.sha256) return false;
    const retained =
      original.paths.find((path) => path.protection.path === proof.path) ??
      record.paths.find((path) => path.protection.path === proof.path);
    const requirements: string[][] = clone(proof.requirements);
    if (retained) {
      if (review.epoch === 'local' && retained.evidence.L)
        addSequence(requirements, recoveryProtectedSpans((await bytes(retained.evidence.L))!));
      else
        for (const sequence of retained.protection.requirements)
          addSequence(requirements, [...sequence]);
      for (const prior of manual.reviews.slice(0, -1))
        for (const path of prior.paths)
          if (path.path === proof.path)
            for (const sequence of path.requirements) {
              if (
                prior.epoch === 'local' &&
                review.epoch === 'incoming' &&
                ['modified', 'added'].includes(retained.protection.incoming) &&
                retained.evidence.L
              ) {
                const superseded = recoveryProtectedSpans((await bytes(retained.evidence.L))!);
                let cursor = 0;
                const additions: string[] = [];
                for (const span of sequence) {
                  if (cursor < superseded.length && span === superseded[cursor]) cursor++;
                  else additions.push(span);
                }
                addSequence(requirements, additions);
              } else addSequence(requirements, [...sequence]);
            }
    }
    assertRecoveryRequirements(actual, requirements);
    for (const label of ['committed', 'staged'] as const) {
      if (proof[label]) {
        const object = await bytes(saved[label]);
        if (!object || proof[label].mode !== '100644') return false;
        assertManualObjectHash(object, proof[label].oid);
        assertRecoveryRequirements(object, requirements);
      } else if (saved[label]) return false;
    }
  }
  if ((review.markers?.length ?? 0) !== (capture.markers?.length ?? 0)) return false;
  for (const marker of review.markers ?? []) {
    const saved = capture.markers?.find((saved) => saved.observation.path === marker.path);
    if (
      !saved ||
      !sameObservation(saved.observation, marker) ||
      bytesHash(await bytes(saved.bytes)) !== marker.sha256
    )
      return false;
  }
  return true;
}
