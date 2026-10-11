import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const TRACE_PROTOCOL = 'causal-app-strict-memory-v4';
export const QUALIFICATION_PROTOCOL = 'causal-paced-125ms-v4';
export const PAYLOAD_BYTES = 3932160;
export const PAYLOAD_SHA256 = '599d089550cc584fb26da5dae8851ee5d3f1f599ba2e02bf118d78c6edcf61d7';
export const TRACE_SLOTS = 16;
export const TRACE_CAPACITY = 131072;
export const TRACE_MEMORY_BYTES = 16777216;
export const SEAL_LIMIT = 65536;
export const RECORD_LIMIT = 2048;
export const SIDEFILE_LIMIT = 268435456;
export const MEMORY_POLICY =
  '16 MiB fixed Float64Array records; transient field objects/process memory separate; JSON/hash/IO ONLY after completion';
export const TIMING_SCOPE =
  'export costs include complete event serialization/hash/write/fsync/close; exclude final seal serialization/publication; driver readback wait includes both';
export const TRACE_FIELDS = [
  'writeIndex',
  'from',
  'to',
  'due',
  'now',
  'bytes',
  'startedAt',
  'nextDue',
  'token',
  'accepted',
  'paused',
] as const;
export const TRACE_KINDS = [
  'go',
  'scheduler-check',
  'pace-arm',
  'timer-dispatch',
  'write-enter',
  'write-return',
  'checkpoint',
  'drain-enter',
  'drain-exit',
  'rebase',
  'pause-enter',
  'pause-exit',
  'stall-enter',
  'stall-exit',
  'forced-completion',
  'dispatch-wait',
  'complete',
] as const;
export const TRACE_MASKS = [
  [64],
  [56],
  [40],
  [0, 8],
  [15],
  [519],
  [1440, 3488],
  [1],
  [0],
  [64],
  [32],
  [0],
  [0],
  [0],
  [0],
  [0],
  [32],
] as const;
type Kind = (typeof TRACE_KINDS)[number];
type Field = (typeof TRACE_FIELDS)[number];
type Fields = Partial<Record<Field, number | boolean | string | null>>;

const finite = z
  .number()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0));
const measure = finite.refine((value) => value >= 0);
const integer = measure.refine(Number.isSafeInteger);
const bytes = integer.max(PAYLOAD_BYTES);
const writeIndex = integer.min(1).max(3931);
const utf8 = (limit: number) =>
  z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= limit);
const identityString = utf8(128);
const token = z.string().regex(/^C(?:[1-9]|[12]\d|30)$/);
const common = {
  runId: identityString,
  sourceId: identityString,
  sequence: integer.max(TRACE_CAPACITY - 1),
  lo: measure,
  hi: measure,
};
const eventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('go'), startedAt: measure }),
  z.strictObject({
    ...common,
    kind: z.literal('scheduler-check'),
    due: measure,
    now: measure,
    bytes,
  }),
  z.strictObject({ ...common, kind: z.literal('pace-arm'), due: measure, bytes }),
  z.strictObject({ ...common, kind: z.literal('timer-dispatch'), due: measure.optional() }),
  z.strictObject({
    ...common,
    kind: z.literal('write-enter'),
    writeIndex,
    from: bytes,
    to: bytes,
    due: measure,
  }),
  z.strictObject({
    ...common,
    kind: z.literal('write-return'),
    writeIndex,
    from: bytes,
    to: bytes,
    accepted: z.boolean(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('checkpoint'),
    bytes,
    nextDue: measure.nullable(),
    token,
    paused: z.boolean(),
  }),
  z.strictObject({ ...common, kind: z.literal('drain-enter'), writeIndex }),
  z.strictObject({ ...common, kind: z.literal('drain-exit') }),
  z.strictObject({ ...common, kind: z.literal('rebase'), startedAt: finite }),
  z.strictObject({ ...common, kind: z.literal('pause-enter'), bytes }),
  z.strictObject({ ...common, kind: z.literal('pause-exit') }),
  z.strictObject({ ...common, kind: z.literal('stall-enter') }),
  z.strictObject({ ...common, kind: z.literal('stall-exit') }),
  z.strictObject({ ...common, kind: z.literal('forced-completion') }),
  z.strictObject({ ...common, kind: z.literal('dispatch-wait') }),
  z.strictObject({ ...common, kind: z.literal('complete'), bytes }),
]);
export type TraceEvent = z.infer<typeof eventSchema>;
const memorySchema = z.strictObject({
  rss: integer,
  heapTotal: integer,
  heapUsed: integer,
  external: integer,
  arrayBuffers: integer,
});
const resourceSchema = z.strictObject({
  userCPUTime: integer,
  systemCPUTime: integer,
  maxRSS: integer,
  sharedMemorySize: integer,
  unsharedDataSize: integer,
  unsharedStackSize: integer,
  minorPageFault: integer,
  majorPageFault: integer,
  swappedOut: integer,
  fsRead: integer,
  fsWrite: integer,
  ipcSent: integer,
  ipcReceived: integer,
  signalsCount: integer,
  voluntaryContextSwitches: integer,
  involuntaryContextSwitches: integer,
});
const versionsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), utf8(128))
  .refine((value) => Object.keys(value).length <= 64 && typeof value.node === 'string');
const modeSchema = z.enum(['normal', 'pause', 'stall', 'completion', 'drain', 'slow', 'malformed']);
export const sealSchema = z.strictObject({
  protocol: z.literal(TRACE_PROTOCOL),
  recordLayout: z.literal('float64-slots-v4'),
  eventEncoding: z.literal('jsonl-number-array-16-v1'),
  fieldMaskVersion: z.literal(1),
  runId: identityString,
  sourceId: identityString,
  mode: modeSchema,
  eventsFile: utf8(4096),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  eventCount: integer.min(1).max(TRACE_CAPACITY),
  eventBytes: integer.min(1).max(SIDEFILE_LIMIT),
  maxEventBytes: integer.min(1).max(RECORD_LIMIT),
  completeSequence: integer.max(TRACE_CAPACITY - 1),
  overflow: z.literal(false),
  traceMemoryBytes: z.literal(TRACE_MEMORY_BYTES),
  traceRecordSlots: z.literal(TRACE_SLOTS),
  traceCapacity: z.literal(TRACE_CAPACITY),
  traceMemoryUsedBytes: integer.max(TRACE_MEMORY_BYTES),
  traceUtilization: measure.max(1),
  producerTraceMemory: z.literal(MEMORY_POLICY),
  noMeasuredPathSerializationHashOrFileIO: z.literal(true),
  payloadBytes: z.literal(PAYLOAD_BYTES),
  completedPayloadBytes: bytes,
  payloadSha256: z.literal(PAYLOAD_SHA256),
  exportStartSourceMs: measure,
  appendMs: measure,
  appendCpuUserMicros: integer,
  appendCpuSystemMicros: integer,
  controlBytes: integer,
  controlHandlingMs: measure,
  controlChunks: integer,
  serializationHashMs: measure,
  exportFileMs: measure,
  exportPreparationMs: measure,
  exportCpuUserMicros: integer,
  exportCpuSystemMicros: integer,
  memoryBeforeGo: memorySchema,
  memoryAfterExport: memorySchema,
  resourceUsage: resourceSchema,
  sourcePid: integer.min(1),
  sourceVersions: versionsSchema,
  sealWriteTimingScope: z.literal(TIMING_SCOPE),
});
export type TraceSeal = z.infer<typeof sealSchema>;
const expectedSchema = z.strictObject({
  runId: identityString,
  sourceId: identityString,
  mode: modeSchema,
  sealPath: utf8(4096),
  eventsFile: utf8(4096),
  arm: z.enum(['active-census', 'hidden-burst-idle']),
  writeEnds: z.array(bytes).length(3931),
});
export type TraceExpected = z.infer<typeof expectedSchema>;
const rawSchema = z.array(finite).length(TRACE_SLOTS);

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateNumericField(field: Field, value: unknown, kind: Kind) {
  if (field === 'accepted' || field === 'paused') {
    requireCondition(typeof value === 'boolean', 'TRACE_BOOLEAN');
    return value ? 1 : 0;
  }
  if (field === 'token') {
    requireCondition(
      typeof value === 'string' && /^C(?:[1-9]|[12]\d|30)$/.test(value),
      'TRACE_TOKEN',
    );
    return Number(value.slice(1));
  }
  if (field === 'nextDue' && value === null) return 0;
  requireCondition(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      Math.abs(value) <= Number.MAX_SAFE_INTEGER,
    'TRACE_NUMBER',
  );
  requireCondition((field === 'startedAt' && kind === 'rebase') || value >= 0, 'TRACE_NEGATIVE');
  if (['writeIndex', 'from', 'to', 'bytes'].includes(field)) {
    requireCondition(
      Number.isSafeInteger(value) &&
        value <= (field === 'writeIndex' ? 3931 : PAYLOAD_BYTES) &&
        (field !== 'writeIndex' || value >= 1),
      'TRACE_INTEGER_BOUNDS',
    );
  }
  return value;
}

// This is the only measured-path packing implementation. It performs no schema parsing, serialization, hashing or I/O.
export function packRecord(
  buffer: Float64Array,
  offset: number,
  kind: Kind,
  sequence: number,
  lo: number,
  hi: number,
  fields: Fields,
) {
  const code = TRACE_KINDS.indexOf(kind);
  requireCondition(
    code >= 0 &&
      Number.isSafeInteger(sequence) &&
      sequence >= 0 &&
      sequence < TRACE_CAPACITY &&
      Number.isSafeInteger(offset) &&
      offset >= 0 &&
      offset + TRACE_SLOTS <= buffer.length,
    'TRACE_RECORD_BOUNDS',
  );
  requireCondition(
    Number.isFinite(lo) &&
      Number.isFinite(hi) &&
      !Object.is(lo, -0) &&
      !Object.is(hi, -0) &&
      lo >= 0 &&
      hi >= lo &&
      hi <= Number.MAX_SAFE_INTEGER,
    'TRACE_CLOCK',
  );
  buffer.fill(0, offset, offset + TRACE_SLOTS);
  buffer[offset] = code;
  buffer[offset + 1] = sequence;
  buffer[offset + 2] = lo;
  buffer[offset + 3] = hi;
  let mask = 0;
  for (const key of Object.keys(fields)) {
    const index = TRACE_FIELDS.indexOf(key as Field);
    requireCondition(index >= 0, 'TRACE_UNKNOWN_FIELD');
    const field = TRACE_FIELDS[index];
    const value = fields[field];
    buffer[offset + 5 + index] = validateNumericField(field, value, kind);
    mask |= 1 << index;
    if (field === 'nextDue' && value === null) mask |= 2048;
  }
  requireCondition((TRACE_MASKS[code] as readonly number[]).includes(mask), 'TRACE_KIND_MASK');
  if (kind === 'write-enter' || kind === 'write-return')
    requireCondition(Number(fields.from) < Number(fields.to), 'TRACE_WRITE_RANGE');
  buffer[offset + 4] = mask;
}

export function decodeRecord(
  raw: unknown,
  identity: { runId: string; sourceId: string },
): TraceEvent {
  const record = rawSchema.parse(raw);
  const [code, sequence, lo, hi, mask] = record;
  requireCondition(
    Number.isInteger(code) &&
      code >= 0 &&
      code < TRACE_KINDS.length &&
      Number.isInteger(mask) &&
      (TRACE_MASKS[code] as readonly number[]).includes(mask),
    'TRACE_CODE_MASK',
  );
  const decoded: Record<string, unknown> = {
    runId: identity.runId,
    sourceId: identity.sourceId,
    kind: TRACE_KINDS[code],
    sequence,
    lo,
    hi,
  };
  for (const [index, field] of TRACE_FIELDS.entries()) {
    const value = record[5 + index];
    if (!(mask & (1 << index))) {
      requireCondition(value === 0, 'TRACE_RESERVED_SLOT');
      continue;
    }
    if (field === 'token') {
      requireCondition(Number.isInteger(value) && value >= 1 && value <= 30, 'TRACE_TOKEN');
      decoded[field] = `C${value}`;
    } else if (field === 'accepted' || field === 'paused') {
      requireCondition(value === 0 || value === 1, 'TRACE_BOOLEAN');
      decoded[field] = value === 1;
    } else if (field === 'nextDue' && mask & 2048) {
      requireCondition(value === 0, 'TRACE_NULL_SLOT');
      decoded[field] = null;
    } else decoded[field] = value;
  }
  const event = eventSchema.parse(decoded);
  const roundtrip = new Float64Array(TRACE_SLOTS);
  const {
    kind,
    sequence: parsedSequence,
    lo: parsedLo,
    hi: parsedHi,
    runId: _runId,
    sourceId: _sourceId,
    ...fields
  } = event;
  packRecord(roundtrip, 0, kind, parsedSequence, parsedLo, parsedHi, fields);
  requireCondition(
    record.every((value, index) => Object.is(value, roundtrip[index])),
    'TRACE_LOSSY_DECODE',
  );
  return event;
}

export class TraceStorage {
  readonly buffer = new Float64Array(TRACE_MEMORY_BYTES / Float64Array.BYTES_PER_ELEMENT);
  count = 0;
  overflow = false;
  append(kind: Kind, lo: number, hi: number, fields: Fields = {}) {
    if (this.count >= TRACE_CAPACITY) {
      this.overflow = true;
      throw new Error('TRACE_STORAGE_OVERFLOW');
    }
    requireCondition(
      !this.count || this.buffer[(this.count - 1) * TRACE_SLOTS] !== 16,
      'TRACE_AFTER_COMPLETE',
    );
    packRecord(this.buffer, this.count * TRACE_SLOTS, kind, this.count, lo, hi, fields);
    this.count++;
  }
}

export class TraceControls {
  private carry = '';
  private checkpoint = 0;
  private started = false;
  consume(text: string) {
    const completed: string[] = [];
    for (const character of text) {
      requireCondition(character.charCodeAt(0) < 128, 'TRACE_CONTROL_ASCII');
      if (character === ' ' || character === '\n' || character === '\r') {
        if (!this.carry) continue;
        const value = this.carry;
        this.carry = '';
        requireCondition(
          value === 'GO' ||
            value === 'Q' ||
            /^P\d+$/.test(value) ||
            /^C(?:[1-9]|[12]\d|30)$/.test(value),
          'TRACE_CONTROL_TOKEN',
        );
        if (value === 'GO') {
          requireCondition(!this.started, 'TRACE_DUPLICATE_GO_CONTROL');
          this.started = true;
        }
        if (value.startsWith('C')) {
          requireCondition(
            this.started && value === `C${this.checkpoint + 1}`,
            'TRACE_CONTROL_CHECKPOINT_ORDER',
          );
          this.checkpoint++;
        }
        completed.push(value);
      } else {
        requireCondition(this.carry.length < 64, 'TRACE_CONTROL_LENGTH');
        this.carry += character;
      }
    }
    return completed;
  }
}

function validateExpected(expected: TraceExpected) {
  expectedSchema.parse(expected);
  requireCondition(
    expected.writeEnds.at(-1) === PAYLOAD_BYTES &&
      expected.writeEnds.every((end, index) => end > (index ? expected.writeEnds[index - 1] : 0)),
    'TRACE_EXPECTED_PLAN',
  );
  requireCondition(
    expected.eventsFile === expected.sealPath + '.events.jsonl',
    'TRACE_EXPECTED_PATH',
  );
  for (const path of [expected.sealPath, expected.eventsFile])
    requireCondition(isAbsolute(path) && resolve(path) === path, 'TRACE_CANONICAL_PATH');
}

function scheduleOffset(payloadBytes: number) {
  // This safe integer numerator divided by a power of two is exact binary64; no timing tolerance or rounding is added.
  const numerator = payloadBytes * 1000;
  requireCondition(Number.isSafeInteger(numerator), 'TRACE_SCHEDULE_PRECISION');
  return numerator / 131072;
}

export function validateTraceEvents(events: TraceEvent[], expected: TraceExpected) {
  validateExpected(expected);
  requireCondition(
    events.length > 0 &&
      events.length <= TRACE_CAPACITY &&
      events[0].kind === 'go' &&
      events.at(-1)?.kind === 'complete',
    'TRACE_GO_COMPLETE',
  );
  let pending: Extract<TraceEvent, { kind: 'write-enter' }> | null = null;
  let written = 0;
  let writes = 0;
  let drain: 'required' | 'entered' | 'rebase' | null = null;
  let paused = false;
  let stalled = false;
  let forced = false;
  let arm: Extract<TraceEvent, { kind: 'pace-arm' }> | 'slow' | null = null;
  let origin = 0;
  let schedulerCheck: Extract<TraceEvent, { kind: 'scheduler-check' }> | null = null;
  let slowDispatchRequired = false;
  const checkpoints: string[] = [];
  for (const [index, raw] of events.entries()) {
    requireCondition(
      Object.values(raw).every((value) => value !== undefined),
      'TRACE_EXPLICIT_UNDEFINED',
    );
    const event = eventSchema.parse(raw);
    requireCondition(
      event.runId === expected.runId &&
        event.sourceId === expected.sourceId &&
        event.sequence === index &&
        event.lo <= event.hi &&
        (!index || event.lo >= events[index - 1].hi),
      'TRACE_SEQUENCE_IDENTITY_CLOCK',
    );
    requireCondition(!index || event.kind !== 'go', 'TRACE_DUPLICATE_GO');
    requireCondition(
      index === events.length - 1 || event.kind !== 'complete',
      'TRACE_EARLY_COMPLETE_EVENT',
    );
    if (event.kind === 'go') {
      requireCondition(
        event.startedAt >= event.lo && event.startedAt <= event.hi,
        'TRACE_GO_ORIGIN',
      );
      origin = event.startedAt;
    }
    const nextDue =
      writes < expected.writeEnds.length
        ? origin + scheduleOffset(expected.writeEnds[writes])
        : null;
    if (event.kind === 'write-enter') {
      requireCondition(
        !pending &&
          !drain &&
          !paused &&
          !stalled &&
          !arm &&
          !forced &&
          event.writeIndex === writes + 1 &&
          event.from === written &&
          event.to === expected.writeEnds[writes],
        'TRACE_WRITE_ENTRY',
      );
      requireCondition(
        schedulerCheck &&
          schedulerCheck.bytes === written &&
          schedulerCheck.now >= schedulerCheck.due &&
          event.due === nextDue &&
          event.due === schedulerCheck.due &&
          !slowDispatchRequired,
        'TRACE_WRITE_SCHEDULE',
      );
      schedulerCheck = null;
      pending = event;
    } else if (event.kind === 'write-return') {
      requireCondition(
        pending &&
          event.writeIndex === pending.writeIndex &&
          event.from === pending.from &&
          event.to === pending.to,
        'TRACE_WRITE_RETURN',
      );
      pending = null;
      written = event.to;
      writes++;
      if (!event.accepted) drain = 'required';
      else if (expected.mode === 'slow') slowDispatchRequired = true;
    } else if (event.kind === 'drain-enter') {
      requireCondition(drain === 'required' && event.writeIndex === writes, 'TRACE_DRAIN_ENTRY');
      drain = 'entered';
    } else if (event.kind === 'drain-exit') {
      requireCondition(drain === 'entered', 'TRACE_DRAIN_EXIT');
      drain = 'rebase';
    } else if (event.kind === 'rebase') {
      requireCondition(drain === 'rebase', 'TRACE_REBASE');
      const offset = scheduleOffset(written);
      // The origin clock read precedes append lo; subtraction endpoints use the same binary64 operation as the producer.
      requireCondition(
        event.startedAt >= events[index - 1].hi - offset && event.startedAt <= event.lo - offset,
        'TRACE_REBASE_ORIGIN',
      );
      origin = event.startedAt;
      schedulerCheck = null;
      drain = null;
    } else if (event.kind === 'pause-enter') {
      requireCondition(
        expected.mode === 'pause' && !paused && !pending && event.bytes === written,
        'TRACE_PAUSE_ENTRY',
      );
      paused = true;
    } else if (event.kind === 'pause-exit') {
      requireCondition(paused, 'TRACE_PAUSE_EXIT');
      paused = false;
    } else if (event.kind === 'stall-enter') {
      requireCondition(expected.mode === 'stall' && !stalled && !pending, 'TRACE_STALL_ENTRY');
      stalled = true;
    } else if (event.kind === 'stall-exit') {
      requireCondition(stalled, 'TRACE_STALL_EXIT');
      stalled = false;
    } else if (event.kind === 'pace-arm') {
      requireCondition(
        !arm &&
          !pending &&
          !drain &&
          !paused &&
          event.bytes === written &&
          schedulerCheck &&
          schedulerCheck.bytes === written &&
          schedulerCheck.now < schedulerCheck.due &&
          event.due === nextDue &&
          event.due === schedulerCheck.due &&
          !slowDispatchRequired,
        'TRACE_PACE_ARM',
      );
      schedulerCheck = null;
      arm = event;
    } else if (event.kind === 'dispatch-wait') {
      requireCondition(
        expected.mode === 'slow' && slowDispatchRequired && !arm && !pending && !drain && !paused,
        'TRACE_DISPATCH_WAIT',
      );
      arm = 'slow';
    } else if (event.kind === 'timer-dispatch') {
      requireCondition(
        arm && (arm === 'slow' ? !Object.hasOwn(event, 'due') : event.due === arm.due),
        'TRACE_TIMER_DISPATCH',
      );
      if (arm === 'slow') slowDispatchRequired = false;
      arm = null;
    } else if (event.kind === 'scheduler-check') {
      // now is read before numeric append; adjacent source trace endpoints bound that read without inventing new clock precision.
      requireCondition(
        !arm &&
          !pending &&
          !drain &&
          !paused &&
          !slowDispatchRequired &&
          event.bytes === written &&
          nextDue !== null &&
          event.due === nextDue &&
          event.now >= events[index - 1].hi &&
          event.now <= event.lo,
        'TRACE_SCHEDULER_STATE',
      );
      schedulerCheck = event;
    } else if (event.kind === 'checkpoint') {
      requireCondition(
        event.bytes === written &&
          event.paused === paused &&
          event.token === `C${checkpoints.length + 1}` &&
          (event.nextDue === null) === (written === PAYLOAD_BYTES || forced),
        'TRACE_CHECKPOINT_STATE_ORDER',
      );
      requireCondition(event.nextDue === (forced ? null : nextDue), 'TRACE_CHECKPOINT_SCHEDULE');
      checkpoints.push(event.token);
    } else if (event.kind === 'forced-completion') {
      requireCondition(
        expected.mode === 'completion' &&
          !forced &&
          !pending &&
          !drain &&
          !paused &&
          !stalled &&
          !arm &&
          schedulerCheck &&
          schedulerCheck.now >= schedulerCheck.due,
        'TRACE_FORCED_COMPLETE',
      );
      forced = true;
    } else if (event.kind === 'complete') {
      requireCondition(
        !pending &&
          !drain &&
          !paused &&
          !stalled &&
          !arm &&
          !slowDispatchRequired &&
          event.bytes === written,
        'TRACE_COMPLETION_STATE',
      );
      requireCondition(
        written === PAYLOAD_BYTES || (forced && expected.mode === 'completion'),
        'TRACE_INCOMPLETE_UNFORCED',
      );
    }
  }
  requireCondition(
    expected.arm === 'active-census'
      ? checkpoints.length === 0
      : expected.mode !== 'normal' || checkpoints.length === 30,
    'TRACE_CHECKPOINT_COUNT',
  );
  return { writes, written };
}

export function serializeCompletedTrace(storage: TraceStorage, expected: TraceExpected) {
  requireCondition(
    !storage.overflow &&
      storage.count > 0 &&
      storage.buffer[(storage.count - 1) * TRACE_SLOTS] === 16,
    'TRACE_NOT_COMPLETE',
  );
  const events: TraceEvent[] = [];
  const lines: string[] = [];
  let eventBytes = 0;
  let maxEventBytes = 0;
  for (let index = 0; index < storage.count; index++) {
    const raw = Array.from(storage.buffer.subarray(index * TRACE_SLOTS, (index + 1) * TRACE_SLOTS));
    events.push(decodeRecord(raw, expected));
    const line = JSON.stringify(raw) + '\n';
    const size = Buffer.byteLength(line);
    eventBytes += size;
    requireCondition(size <= RECORD_LIMIT && eventBytes <= SIDEFILE_LIMIT, 'TRACE_EXPORT_LIMIT');
    maxEventBytes = Math.max(maxEventBytes, size);
    lines.push(line);
  }
  validateTraceEvents(events, expected);
  const serialized = lines.join('');
  return {
    serialized,
    events,
    eventBytes,
    maxEventBytes,
    digest: createHash('sha256').update(serialized).digest('hex'),
  };
}

export function validateSeal(value: unknown, expected: TraceExpected, events: TraceEvent[]) {
  validateExpected(expected);
  const seal = sealSchema.parse(value);
  requireCondition(
    seal.runId === expected.runId &&
      seal.sourceId === expected.sourceId &&
      seal.mode === expected.mode &&
      seal.eventsFile === expected.eventsFile,
    'TRACE_SEAL_IDENTITY',
  );
  requireCondition(
    seal.eventCount === events.length &&
      seal.completeSequence === seal.eventCount - 1 &&
      seal.maxEventBytes <= seal.eventBytes &&
      seal.traceMemoryUsedBytes === seal.eventCount * 128 &&
      seal.traceUtilization === seal.eventCount / TRACE_CAPACITY,
    'TRACE_SEAL_STORAGE',
  );
  const { written } = validateTraceEvents(events, expected);
  requireCondition(
    seal.completedPayloadBytes === written && seal.exportStartSourceMs >= events.at(-1)!.hi,
    'TRACE_EXPORT_COMPLETION',
  );
  return seal;
}

function unchanged(before: Stats, after: Stats) {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}
async function checkedStat(path: string, limit: number) {
  requireCondition((await realpath(dirname(path))) === dirname(path), 'TRACE_SYMLINK_PARENT');
  const stats = await lstat(path);
  requireCondition(
    stats.isFile() && !stats.isSymbolicLink() && stats.size > 0 && stats.size <= limit,
    'TRACE_ACTUAL_FILE_LIMIT_OR_TYPE',
  );
  return stats;
}
async function checkedOpen(path: string, stats: Stats) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireCondition(unchanged(stats, await handle.stat()), 'TRACE_FILE_REPLACED');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function consume(handle: FileHandle, limit: number, onChunk: (chunk: Buffer) => void) {
  const buffer = Buffer.alloc(Math.min(limit, 65536));
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, limit - total + 1),
      null,
    );
    if (!bytesRead) break;
    total += bytesRead;
    requireCondition(total <= limit, 'TRACE_READ_LIMIT');
    onChunk(buffer.subarray(0, bytesRead));
  }
  return total;
}

export async function readSealedTrace(expected: TraceExpected) {
  const started = performance.now();
  validateExpected(expected);
  // Both actual paths are bounded before either file is read; seal metadata is never a read allowance.
  const sealStat = await checkedStat(expected.sealPath, SEAL_LIMIT);
  const eventStat = await checkedStat(expected.eventsFile, SIDEFILE_LIMIT);
  const sealHandle = await checkedOpen(expected.sealPath, sealStat);
  let eventHandle: FileHandle | undefined;
  try {
    eventHandle = await checkedOpen(expected.eventsFile, eventStat);
    const sealChunks: Buffer[] = [];
    await consume(sealHandle, SEAL_LIMIT, (chunk) => sealChunks.push(Buffer.from(chunk)));
    const seal = sealSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(sealChunks),
        ),
      ),
    );
    requireCondition(
      seal.runId === expected.runId &&
        seal.sourceId === expected.sourceId &&
        seal.mode === expected.mode &&
        seal.eventsFile === expected.eventsFile,
      'TRACE_SEAL_IDENTITY',
    );
    const events: TraceEvent[] = [];
    const hash = createHash('sha256');
    const line = Buffer.alloc(RECORD_LIMIT);
    let lineBytes = 0;
    let maxEventBytes = 0;
    const observedTraceBytes = await consume(eventHandle, SIDEFILE_LIMIT, (chunk) => {
      hash.update(chunk);
      for (const byte of chunk) {
        requireCondition(lineBytes < RECORD_LIMIT, 'TRACE_LINE_LIMIT');
        line[lineBytes++] = byte;
        if (byte !== 10) continue;
        requireCondition(
          lineBytes > 1 &&
            !line.subarray(0, lineBytes).includes(13) &&
            events.length < TRACE_CAPACITY,
          'TRACE_LINE_OR_COUNT_LIMIT',
        );
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          line.subarray(0, lineBytes - 1),
        );
        requireCondition(!text.includes('\uFEFF'), 'TRACE_BOM');
        events.push(decodeRecord(JSON.parse(text), expected));
        maxEventBytes = Math.max(maxEventBytes, lineBytes);
        lineBytes = 0;
      }
    });
    requireCondition(lineBytes === 0, 'TRACE_MISSING_FINAL_LF');
    for (const [path, handle, before] of [
      [expected.sealPath, sealHandle, sealStat],
      [expected.eventsFile, eventHandle, eventStat],
    ] as const) {
      requireCondition(
        unchanged(before, await handle.stat()) && unchanged(before, await lstat(path)),
        'TRACE_FILE_CHANGED',
      );
      requireCondition((await realpath(dirname(path))) === dirname(path), 'TRACE_SYMLINK_PARENT');
    }
    requireCondition(
      observedTraceBytes === seal.eventBytes &&
        maxEventBytes === seal.maxEventBytes &&
        hash.digest('hex') === seal.digest,
      'TRACE_RAW_DIGEST_BYTES',
    );
    validateSeal(seal, expected, events);
    const { writes, written } = validateTraceEvents(events, expected);
    return {
      ...seal,
      events,
      readbackVerified: true as const,
      observedTraceBytes,
      observedEventCount: events.length,
      sourceWriteCountVerified: writes,
      completedPayloadBytesVerified: written,
      readbackMs: performance.now() - started,
      offlineReadbackHeapBytes: process.memoryUsage().heapUsed,
    };
  } finally {
    await eventHandle?.close();
    await sealHandle.close();
  }
}
export type ReadTrace = Awaited<ReturnType<typeof readSealedTrace>>;

export function sourceProfile(trace: ReadTrace) {
  const entries = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'write-enter' }> => event.kind === 'write-enter',
  );
  const returns = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'write-return' }> =>
      event.kind === 'write-return',
  );
  const spans = entries.length
    ? [
        { kind: 'startup', ms: returns[0].hi - trace.events[0].lo },
        ...entries.slice(1).map((entry, index) => ({
          kind: 'adjacent',
          from: entries[index].writeIndex,
          to: entry.writeIndex,
          ms: returns[index + 1].hi - entries[index].lo,
        })),
        { kind: 'finish', ms: trace.events.at(-1)!.hi - entries.at(-1)!.lo },
      ]
    : [];
  const generationMs = trace.events.at(-1)!.hi - trace.events[0].lo;
  const throughput = (trace.completedPayloadBytes * 1000) / generationMs;
  const maxSpan = spans.length
    ? spans.reduce((largest, span) => (span.ms > largest.ms ? span : largest))
    : null;
  const errors: string[] = [];
  if (!maxSpan || maxSpan.ms > 125) errors.push('source-progress-span-budget');
  if (!(throughput >= 124518.4)) errors.push('whole-source-throughput-budget');
  if (trace.completedPayloadBytes !== PAYLOAD_BYTES || entries.length !== 3931)
    errors.push('incomplete-source');
  return {
    errors,
    spans,
    maxSpan,
    generationMs,
    throughput,
    sourceWriteCount: entries.length,
    falseWrites: returns.filter((event) => !event.accepted).length,
    sourceLateness: entries.map((event) => event.lo - event.due),
  };
}

interface PayloadCallback {
  id: string;
  at: number;
  from: number;
  to: number;
  lastBoundary: number;
}
interface Attempt {
  index: number;
  target: number;
  status: string;
  token?: string;
  before?: PayloadCallback;
  triggerAt?: number;
  ackAt?: number;
  firstMs?: number;
  checkpointSentAt?: number;
  atAckBytes?: number;
}
interface Observations {
  payload: string;
  unexpected: string[];
  callbacks: PayloadCallback[];
  attempts: Attempt[];
}

export function qualify(
  trace: ReadTrace,
  observed: Observations,
  identity: { runId: string; sourceId: string; sessionId: string; arm: TraceExpected['arm'] },
) {
  const profile = sourceProfile(trace);
  const errors = [...profile.errors];
  if (
    trace.protocol !== TRACE_PROTOCOL ||
    !trace.readbackVerified ||
    trace.runId !== identity.runId ||
    trace.sourceId !== identity.sourceId
  )
    errors.push('invalid-seal-identity-or-overflow');
  if (
    observed.payload.length !== PAYLOAD_BYTES ||
    createHash('sha256').update(observed.payload).digest('hex') !== PAYLOAD_SHA256 ||
    observed.unexpected.length
  )
    errors.push('payload-or-stdout-control-mismatch');
  const entries = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'write-enter' }> => event.kind === 'write-enter',
  );
  const returns = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'write-return' }> =>
      event.kind === 'write-return',
  );
  const checkpoints = trace.events.filter(
    (event): event is Extract<TraceEvent, { kind: 'checkpoint' }> => event.kind === 'checkpoint',
  );
  if (
    identity.arm === 'hidden-burst-idle' &&
    (observed.attempts.length !== 30 ||
      !observed.attempts.every(
        (attempt, index) =>
          attempt.index === index + 1 &&
          attempt.target === Math.floor((PAYLOAD_BYTES * (index + 1)) / 31),
      ) ||
      checkpoints.length !== 30 ||
      trace.controlBytes !== 114)
  )
    errors.push('exact-thirty-opportunities-or-controls');
  if (
    !observed.callbacks.every(
      (callback, index) =>
        callback.id === identity.sessionId &&
        Number.isFinite(callback.at) &&
        callback.at >= 0 &&
        Number.isSafeInteger(callback.from) &&
        Number.isSafeInteger(callback.to) &&
        callback.to > callback.from &&
        callback.to <= observed.payload.length &&
        callback.from === (index ? observed.callbacks[index - 1].to : 0) &&
        (!index || callback.at >= observed.callbacks[index - 1].at) &&
        Number.isSafeInteger(callback.lastBoundary) &&
        callback.lastBoundary === observed.payload.lastIndexOf('\n', callback.to - 1) + 1,
    )
  )
    errors.push('callback-session-or-byte-continuity');
  if (observed.callbacks.at(-1)?.to !== observed.payload.length)
    errors.push('incomplete-callback-history');
  const rows = observed.attempts.map((attempt) => {
    const reasons = [...errors];
    const checkpoint = checkpoints.find((event) => event.token === `C${attempt.index}`);
    const anchor = entries.find((event) => event.to === attempt.before?.lastBoundary);
    const following = checkpoint && entries.find((event) => event.sequence > checkpoint.sequence);
    const delivered =
      following &&
      observed.callbacks.find(
        (callback) =>
          callback.id === identity.sessionId &&
          callback.at > (attempt.ackAt ?? Infinity) &&
          callback.from <= following.from &&
          callback.to >= following.to,
      );
    const actualPrecedingCallback =
      attempt.before &&
      observed.callbacks
        .filter(
          (callback) =>
            callback.id === identity.sessionId && callback.at <= (attempt.triggerAt ?? -1),
        )
        .at(-1);
    const latestCallbackMatches =
      actualPrecedingCallback &&
      attempt.before &&
      (['id', 'at', 'from', 'to', 'lastBoundary'] as const).every(
        (key) => actualPrecedingCallback[key] === attempt.before![key],
      );
    if (!latestCallbackMatches) reasons.push('not-latest-pre-trigger-callback');
    if (
      !Number.isSafeInteger(attempt.index) ||
      attempt.index < 1 ||
      attempt.index > 30 ||
      attempt.target !== Math.floor((PAYLOAD_BYTES * attempt.index) / 31) ||
      !actualPrecedingCallback ||
      actualPrecedingCallback.to < attempt.target
    )
      reasons.push('target-not-crossed-before-trigger');
    const actualAckCallback = observed.callbacks
      .filter((callback) => callback.at <= (attempt.ackAt ?? -1))
      .at(-1);
    if (attempt.atAckBytes !== actualAckCallback?.to) reasons.push('ack-byte-count-mismatch');
    const priorAttempt = observed.attempts[attempt.index - 2];
    if (priorAttempt?.status === 'acked' && !(attempt.triggerAt! >= priorAttempt.checkpointSentAt!))
      reasons.push('attempt-clock-order');
    const precedingContainsBoundary =
      anchor &&
      actualPrecedingCallback &&
      observed.callbacks.some(
        (callback) =>
          callback.at <= actualPrecedingCallback.at &&
          callback.from < anchor.to &&
          callback.to >= anchor.to,
      ) &&
      observed.payload[anchor.to - 1] === '\n';
    const clockFields = [
      attempt.triggerAt,
      attempt.ackAt,
      attempt.firstMs,
      attempt.checkpointSentAt,
    ];
    if (
      !clockFields.every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
      ) ||
      attempt.firstMs !== (attempt.ackAt ?? NaN) - (attempt.triggerAt ?? NaN) ||
      attempt.status !== 'acked' ||
      attempt.token !== `P${String(attempt.index).padStart(4, '0')}` ||
      !precedingContainsBoundary ||
      !latestCallbackMatches ||
      actualPrecedingCallback!.at > (attempt.triggerAt ?? -1) ||
      actualPrecedingCallback!.to >= PAYLOAD_BYTES ||
      !Number.isSafeInteger(attempt.atAckBytes) ||
      (attempt.atAckBytes ?? PAYLOAD_BYTES) >= PAYLOAD_BYTES ||
      (attempt.atAckBytes ?? -1) < actualPrecedingCallback!.to ||
      (attempt.ackAt ?? Infinity) > (attempt.checkpointSentAt ?? -1) ||
      !checkpoint ||
      checkpoint.bytes >= PAYLOAD_BYTES ||
      !anchor ||
      anchor.sequence >= checkpoint.sequence ||
      !following ||
      !delivered
    )
      reasons.push('missing-incomplete-causal-byte-chain');
    const envelope =
      anchor && checkpoint ? trace.events.slice(anchor.sequence, checkpoint.sequence + 1) : [];
    const bad = envelope.filter(
      (event) =>
        [
          'drain-enter',
          'drain-exit',
          'rebase',
          'pause-enter',
          'pause-exit',
          'complete',
          'forced-completion',
        ].includes(event.kind) ||
        (event.kind === 'write-return' && !event.accepted),
    );
    if (bad.length || checkpoint?.paused) reasons.push('disqualifying-source-state');
    if (
      anchor &&
      checkpoint &&
      entries.some(
        (entry, index) =>
          entry.sequence >= anchor.sequence &&
          entry.sequence <= checkpoint.sequence &&
          returns[index].sequence > checkpoint.sequence,
      )
    )
      reasons.push('pending-write-at-checkpoint');
    return {
      index: attempt.index,
      causalPacedSegmentQualified: !reasons.length,
      claim:
        'ACK causally enclosed by a trace-verified paced-output segment with approved rate/gap budgets and preceding/following delivered payload',
      reasons: [...new Set(reasons)],
      firstMs: attempt.firstMs,
      insideDelta: (attempt.atAckBytes ?? 0) - (attempt.before?.to ?? 0),
      sourceAnchorSequence: anchor?.sequence,
      checkpointSequence: checkpoint?.sequence,
      followingSequence: following?.sequence,
      followingCallback: delivered,
      badStates: bad.map((event) => ({ kind: event.kind, sequence: event.sequence })),
      deadlineLatenessMs:
        checkpoint?.nextDue === null
          ? null
          : checkpoint
            ? checkpoint.lo - checkpoint.nextDue
            : undefined,
    };
  });
  return {
    ...profile,
    errors,
    protocol: QUALIFICATION_PROTOCOL,
    declared: rows.length,
    qualified: rows.filter((row) => row.causalPacedSegmentQualified).length,
    rows,
    checkpointCount: checkpoints.length,
    appendMs: trace.appendMs,
    traceEvents: trace.events.length,
    controlBytes: trace.controlBytes,
  };
}
