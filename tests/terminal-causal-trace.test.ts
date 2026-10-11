import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, open, symlink, mkdir } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  TRACE_KINDS,
  TRACE_MASKS,
  TRACE_FIELDS,
  TraceStorage,
  TraceControls,
  decodeRecord,
  packRecord,
  serializeCompletedTrace,
  readSealedTrace,
  sealSchema,
  validateSeal,
  validateTraceEvents,
  sourceProfile,
  qualify,
  PAYLOAD_BYTES,
  PAYLOAD_SHA256,
  TRACE_PROTOCOL,
  TRACE_CAPACITY,
  TRACE_MEMORY_BYTES,
  SEAL_LIMIT,
  RECORD_LIMIT,
  SIDEFILE_LIMIT,
  MEMORY_POLICY,
  TIMING_SCOPE,
} from './fixtures/terminal-causal-trace';
import type {
  TraceExpected,
  TraceEvent,
  TraceSeal,
  ReadTrace,
} from './fixtures/terminal-causal-trace';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

// Synthetic clock/state/readback fixtures, not built-app runtime negative evidence.
const fixtureSource = readFileSync(
  join(__dirname, 'fixtures/sustained-output-fixture.mjs'),
  'utf8',
);
const sourcePlan = fixtureSource.slice(0, fixtureSource.indexOf('// ---- stdin echo'));
const plannedLines: string[] = runInNewContext(sourcePlan + '\nlines;', {
  process: {
    argv: ['node', 'fixture', '--mode', 'burst', '--seed', '271828'],
    stdout: {
      write() {
        throw new Error('invalid fixture plan');
      },
    },
    exit() {
      throw new Error('invalid fixture plan');
    },
  },
});
const payload = plannedLines.join('\n') + '\n';
let cumulative = 0;
const writeEnds = plannedLines.map((line) => (cumulative += line.length + 1));
const context: TraceExpected = {
  runId: 'synthetic-run',
  sourceId: 'synthetic-source',
  mode: 'normal',
  arm: 'active-census',
  sealPath: '/tmp/trace-test.json',
  eventsFile: '/tmp/trace-test.json.events.jsonl',
  writeEnds,
};
const fields: Parameters<typeof packRecord>[6][] = [
  { startedAt: 0 },
  { due: 1.125, now: 0, bytes: 0 },
  { due: 1.125, bytes: 0 },
  { due: 1.125 },
  { writeIndex: 1, from: 0, to: writeEnds[0], due: 1.125 },
  { writeIndex: 1, from: 0, to: writeEnds[0], accepted: false },
  { bytes: 0, nextDue: null, token: 'C30', paused: false },
  { writeIndex: 1 },
  {},
  { startedAt: -1.125 },
  { bytes: 0 },
  {},
  {},
  {},
  {},
  {},
  { bytes: PAYLOAD_BYTES },
];
function raw(kindIndex: number, extra: Parameters<typeof packRecord>[6] = fields[kindIndex]) {
  const buffer = new Float64Array(16);
  packRecord(buffer, 0, TRACE_KINDS[kindIndex], 0, 0.123456789012345, 0.123456789012346, extra);
  return Array.from(buffer);
}
function completeStorage() {
  const storage = new TraceStorage();
  storage.append('go', 0, 0, { startedAt: 0 });
  for (let index = 0; index < writeEnds.length; index++) {
    const from = index ? writeEnds[index - 1] : 0;
    const to = writeEnds[index];
    const at = (to * 1000) / 131072;
    storage.append('scheduler-check', at, at, { due: at, now: at, bytes: from });
    storage.append('write-enter', at, at, { writeIndex: index + 1, from, to, due: at });
    storage.append('write-return', at, at, { writeIndex: index + 1, from, to, accepted: true });
  }
  storage.append('complete', 30000, 30000, { bytes: PAYLOAD_BYTES });
  return storage;
}
function sealFor(
  exported: ReturnType<typeof serializeCompletedTrace>,
  expected = context,
): TraceSeal {
  return {
    protocol: TRACE_PROTOCOL,
    recordLayout: 'float64-slots-v4',
    eventEncoding: 'jsonl-number-array-16-v1',
    fieldMaskVersion: 1,
    runId: expected.runId,
    sourceId: expected.sourceId,
    mode: expected.mode,
    eventsFile: expected.eventsFile,
    digest: exported.digest,
    eventCount: exported.events.length,
    eventBytes: exported.eventBytes,
    maxEventBytes: exported.maxEventBytes,
    completeSequence: exported.events.length - 1,
    overflow: false,
    traceMemoryBytes: TRACE_MEMORY_BYTES,
    traceRecordSlots: 16,
    traceCapacity: TRACE_CAPACITY,
    traceMemoryUsedBytes: exported.events.length * 128,
    traceUtilization: exported.events.length / TRACE_CAPACITY,
    producerTraceMemory: MEMORY_POLICY,
    noMeasuredPathSerializationHashOrFileIO: true,
    payloadBytes: PAYLOAD_BYTES,
    completedPayloadBytes: PAYLOAD_BYTES,
    payloadSha256: PAYLOAD_SHA256,
    exportStartSourceMs: 30001,
    appendMs: 0,
    appendCpuUserMicros: 0,
    appendCpuSystemMicros: 0,
    controlBytes: 3,
    controlHandlingMs: 0,
    controlChunks: 1,
    serializationHashMs: 0,
    exportFileMs: 0,
    exportPreparationMs: 0,
    exportCpuUserMicros: 0,
    exportCpuSystemMicros: 0,
    memoryBeforeGo: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    memoryAfterExport: { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 },
    resourceUsage: {
      userCPUTime: 0,
      systemCPUTime: 0,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    },
    sourcePid: 1,
    sourceVersions: { node: 'synthetic' },
    sealWriteTimingScope: TIMING_SCOPE,
  };
}
const exported = serializeCompletedTrace(completeStorage(), context);
const validSeal = sealFor(exported);
async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'condash-causal-v4-'));
  const sealPath = join(directory, 'seal.json');
  const expected = { ...context, sealPath, eventsFile: sealPath + '.events.jsonl' };
  const seal = sealFor(exported, expected);
  await writeFile(expected.eventsFile, exported.serialized);
  await writeFile(sealPath, JSON.stringify(seal));
  return { expected, seal, directory };
}

describe('canonical lossless numeric storage', () => {
  it('parses split controls exactly once with bounded carry, no substring/duplicate identities', () => {
    const controls = new TraceControls();
    expect(controls.consume('G')).toEqual([]);
    expect(controls.consume('O C')).toEqual(['GO']);
    expect(controls.consume('1 C2 ')).toEqual(['C1', 'C2']);
    expect(() => controls.consume('C2 ')).toThrow('TRACE_CONTROL_CHECKPOINT_ORDER');
    for (const value of ['xC1 ', 'C01 ', 'C0 ', 'C31 ', 'é ', 'X'.repeat(65)])
      expect(() => new TraceControls().consume('GO ' + value)).toThrow();
    expect(() => new TraceControls().consume('C1 ')).toThrow();
  });
  it.each(TRACE_KINDS.map((kind, index) => [kind, index] as const))(
    'roundtrips every field of %s',
    (_kind, index) => {
      const record = raw(index);
      const decoded = decodeRecord(JSON.parse(JSON.stringify(record)), context);
      expect(decoded).toMatchObject({
        ...fields[index],
        kind: TRACE_KINDS[index],
        lo: record[2],
        hi: record[3],
      });
      expect(record[4]).toBe(TRACE_MASKS[index].at(-1));
    },
  );
  it('distinguishes absent due, null nextDue, numeric zero and present false', () => {
    expect(decodeRecord(raw(3, {}), context)).not.toHaveProperty('due');
    expect(decodeRecord(raw(3, { due: 0 }), context)).toHaveProperty('due', 0);
    const checkpoint = { bytes: 0, nextDue: 0, token: 'C1', paused: false };
    expect(raw(6, checkpoint)[4]).toBe(1440);
    expect(raw(6, { ...checkpoint, nextDue: null })[4]).toBe(3488);
    expect(decodeRecord(raw(6, checkpoint), context)).toHaveProperty('nextDue', 0);
    expect(decodeRecord(raw(6, { ...checkpoint, nextDue: null }), context)).toHaveProperty(
      'nextDue',
      null,
    );
    expect(decodeRecord(raw(5), context)).toHaveProperty('accepted', false);
    expect(() => raw(3, { due: undefined } as never)).toThrow();
  });
  it.each([NaN, Infinity, -Infinity, -0, 1e20])(
    'rejects noncanonical number %s before conversion',
    (value) => {
      const record = raw(0);
      record[2] = value;
      expect(() => decodeRecord(record, context)).toThrow();
    },
  );
  it.each([
    [0, 17],
    [0, 1.5],
    [4, 4096],
    [4, 65],
    [5, 1],
    [13, 0],
    [13, 30.5],
    [14, 2],
    [12, 1],
  ])('rejects code/mask/reserved/value at slot %s', (slot, value) => {
    const record = raw(slot === 13 || slot === 12 ? 6 : slot === 14 ? 5 : 0);
    record[slot] = value;
    expect(() => decodeRecord(record, context)).toThrow();
  });
  it('rejects wrong types, fractions, missing fields and unknown fields', () => {
    for (const value of [undefined, 'true', 1, null])
      expect(() => raw(5, { ...fields[5], accepted: value } as never)).toThrow();
    for (const value of ['C01', 'C0', 'C31', 'xC1'])
      expect(() => raw(6, { ...fields[6], token: value })).toThrow();
    expect(() => raw(4, { ...fields[4], to: 1.5 })).toThrow();
    expect(() => raw(0, { startedAt: 0, unknown: 0 } as never)).toThrow();
  });
  it('append performs no JSON, hashing or filesystem work and overflow invalidates export', () => {
    const storage = new TraceStorage();
    const serialize = vi.spyOn(JSON, 'stringify');
    const io = vi.spyOn(filesystem, 'open');
    for (let index = 0; index < TRACE_CAPACITY; index++)
      storage.append('stall-enter', index, index);
    expect(serialize).not.toHaveBeenCalled();
    expect(io).not.toHaveBeenCalled();
    expect(storage.buffer.byteLength).toBe(TRACE_MEMORY_BYTES);
    expect(() => storage.append('complete', TRACE_CAPACITY, TRACE_CAPACITY, { bytes: 0 })).toThrow(
      'TRACE_STORAGE_OVERFLOW',
    );
    expect(storage.overflow).toBe(true);
    expect(() => serializeCompletedTrace(storage, context)).toThrow('TRACE_NOT_COMPLETE');
    serialize.mockRestore();
    io.mockRestore();
  });
  it('all slots are assigned by the one mapping and all required masks exist', () => {
    expect(TRACE_FIELDS).toHaveLength(11);
    expect(TRACE_KINDS).toHaveLength(17);
    expect(TRACE_MASKS).toHaveLength(17);
    expect(() => serializeCompletedTrace(new TraceStorage(), context)).toThrow(
      'TRACE_NOT_COMPLETE',
    );
  });
});

describe('strict seal and event schemas', () => {
  it.each([undefined, null, '30001', NaN, Infinity, -1, 1e20])(
    'requires finite numeric exportStartSourceMs: %s',
    (value) => {
      expect(sealSchema.safeParse({ ...validSeal, exportStartSourceMs: value }).success).toBe(
        false,
      );
    },
  );
  it.each(['false', false, undefined, null, 1])(
    'requires literal true no-I/O declaration: %s',
    (value) => {
      expect(
        sealSchema.safeParse({ ...validSeal, noMeasuredPathSerializationHashOrFileIO: value })
          .success,
      ).toBe(false);
    },
  );
  it.each(['false', true, undefined, 0])('requires literal false overflow: %s', (value) => {
    expect(sealSchema.safeParse({ ...validSeal, overflow: value }).success).toBe(false);
  });
  it('rejects unknown keys everywhere except bounded sourceVersions', () => {
    for (const field of ['memoryBeforeGo', 'memoryAfterExport', 'resourceUsage'])
      expect(
        sealSchema.safeParse({
          ...validSeal,
          [field]: { ...(validSeal[field as keyof TraceSeal] as object), unknown: 0 },
        }).success,
      ).toBe(false);
    expect(sealSchema.safeParse({ ...validSeal, unknown: true }).success).toBe(false);
    expect(
      sealSchema.safeParse({ ...validSeal, sourceVersions: { node: '24', another: '1' } }).success,
    ).toBe(true);
    expect(
      sealSchema.safeParse({ ...validSeal, sourceVersions: { node: '24', 'bad key': '1' } })
        .success,
    ).toBe(false);
    expect(
      sealSchema.safeParse({
        ...validSeal,
        sourceVersions: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [index ? `v${index}` : 'node', '1']),
        ),
      }).success,
    ).toBe(false);
    expect(sealSchema.safeParse({ ...validSeal, runId: 'é'.repeat(65) }).success).toBe(false);
    const events = exported.events.map((event) => ({ ...event }));
    expect(() =>
      validateTraceEvents(
        [{ ...events[0], unknown: 1 } as unknown as TraceEvent, ...events.slice(1)],
        context,
      ),
    ).toThrow();
  });
  it.each([
    'protocol',
    'recordLayout',
    'eventEncoding',
    'fieldMaskVersion',
    'traceCapacity',
    'payloadSha256',
  ])('rejects wrong protocol binding %s', (field) => {
    expect(sealSchema.safeParse({ ...validSeal, [field]: 'wrong' }).success).toBe(false);
  });
  it.each([
    'runId',
    'sourceId',
    'mode',
    'eventsFile',
    'completeSequence',
    'traceUtilization',
    'traceMemoryUsedBytes',
    'completedPayloadBytes',
  ])('reconciles identity/storage/completion %s', (field) => {
    const value = validSeal[field as keyof TraceSeal];
    expect(() =>
      validateSeal(
        { ...validSeal, [field]: typeof value === 'number' ? value + 1 : 'wrong' },
        context,
        exported.events,
      ),
    ).toThrow();
  });
  it('rejects sequence/clock/byte and unpaired state corruption', () => {
    for (const [index, change] of [
      [1, { sequence: 99 }],
      [2, { from: 1 }],
      [2, { accepted: false }],
      [1, { lo: 1000 }],
      [0, { startedAt: 10 }],
    ] as const) {
      const events = exported.events.map((event) => ({ ...event }));
      Object.assign(events[index], change);
      expect(() => validateTraceEvents(events, context)).toThrow();
    }
    const terminal = exported.events.at(-1)!;
    expect(() =>
      validateTraceEvents(
        [...exported.events.slice(0, -1), { ...terminal, kind: 'drain-exit' } as TraceEvent],
        context,
      ),
    ).toThrow();
  });
});

describe('actual bounded reader (synthetic files)', () => {
  it('consumes complete raw bytes and verifies digest/count/size and source completion', async () => {
    const { expected } = await files();
    const result = await readSealedTrace(expected);
    expect(result.readbackVerified).toBe(true);
    expect(result.sourceWriteCountVerified).toBe(3931);
    expect(result.events).toEqual(exported.events);
  });
  it.each([SEAL_LIMIT, SEAL_LIMIT + 1])(
    'checks seal stat and streaming boundary %s',
    async (size) => {
      const { expected, seal } = await files();
      const text = JSON.stringify(seal);
      await writeFile(expected.sealPath, text + ' '.repeat(size - Buffer.byteLength(text)));
      if (size === SEAL_LIMIT)
        expect((await readSealedTrace(expected)).readbackVerified).toBe(true);
      else
        await expect(readSealedTrace(expected)).rejects.toThrow('TRACE_ACTUAL_FILE_LIMIT_OR_TYPE');
    },
  );
  it.each([RECORD_LIMIT, RECORD_LIMIT + 1])(
    'checks per-record bound before parsing %s',
    async (size) => {
      const { expected, seal } = await files();
      const [first, ...rest] = exported.serialized.split('\n');
      const padded =
        first + ' '.repeat(size - Buffer.byteLength(first) - 1) + '\n' + rest.join('\n');
      await writeFile(expected.eventsFile, padded);
      await writeFile(
        expected.sealPath,
        JSON.stringify({
          ...seal,
          eventBytes: Buffer.byteLength(padded),
          maxEventBytes: Math.min(size, RECORD_LIMIT),
          digest: createHash('sha256').update(padded).digest('hex'),
        }),
      );
      if (size === RECORD_LIMIT)
        expect((await readSealedTrace(expected)).readbackVerified).toBe(true);
      else await expect(readSealedTrace(expected)).rejects.toThrow('TRACE_LINE_LIMIT');
    },
  );
  it.each([SIDEFILE_LIMIT, SIDEFILE_LIMIT + 1])(
    'checks actual sparse sidefile, independent of advertised small counts: %s',
    async (size) => {
      const { expected } = await files();
      const handle = await open(expected.eventsFile, 'w');
      await handle.truncate(size);
      await handle.close();
      await expect(readSealedTrace(expected)).rejects.toThrow(
        size > SIDEFILE_LIMIT ? 'TRACE_ACTUAL_FILE_LIMIT_OR_TYPE' : 'TRACE_LINE_LIMIT',
      );
    },
  );
  it.each(['utf8', 'no-lf', 'cr', 'blank', 'bom', 'count', 'digest', 'truncated-seal'])(
    'rejects raw corruption %s',
    async (mode) => {
      const { expected, seal } = await files();
      const replacements: Record<string, string | Buffer> = {
        utf8: Buffer.from([255, 10]),
        'no-lf': exported.serialized.trimEnd(),
        cr: exported.serialized.replace('\n', '\r\n'),
        blank: '\n',
        bom: '\uFEFF' + exported.serialized,
      };
      if (mode in replacements) await writeFile(expected.eventsFile, replacements[mode]);
      else
        await writeFile(
          expected.sealPath,
          mode === 'truncated-seal'
            ? '{'
            : JSON.stringify({
                ...seal,
                [mode === 'count' ? 'eventCount' : 'digest']: mode === 'count' ? 1 : '0'.repeat(64),
              }),
        );
      await expect(readSealedTrace(expected)).rejects.toThrow();
    },
  );
  it('rejects the 131073rd record before decoding or retention', async () => {
    const { expected } = await files();
    await writeFile(
      expected.eventsFile,
      (JSON.stringify(raw(0)) + '\n').repeat(TRACE_CAPACITY + 1),
    );
    await expect(readSealedTrace(expected)).rejects.toThrow('TRACE_LINE_OR_COUNT_LIMIT');
  }, 30000);
  it('rejects symlinks, nonregular files and noncanonical parent paths', async () => {
    const { expected, directory } = await files();
    const link = join(directory, 'link.json');
    await symlink(expected.sealPath, link);
    await expect(
      readSealedTrace({ ...expected, sealPath: link, eventsFile: link + '.events.jsonl' }),
    ).rejects.toThrow('TRACE_ACTUAL_FILE_LIMIT_OR_TYPE');
    const subdir = join(directory, 'sub');
    await mkdir(subdir);
    await expect(
      readSealedTrace({ ...expected, sealPath: subdir, eventsFile: subdir + '.events.jsonl' }),
    ).rejects.toThrow();
    const parent = directory + '-link';
    await symlink(directory, parent);
    await expect(
      readSealedTrace({
        ...expected,
        sealPath: join(parent, 'seal.json'),
        eventsFile: join(parent, 'seal.json.events.jsonl'),
      }),
    ).rejects.toThrow('TRACE_SYMLINK_PARENT');
  });
  it('detects file growth and pathname replacement during actual bounded consumption', async () => {
    for (const replace of [false, true]) {
      const { expected } = await files();
      const realOpen = filesystem.open;
      const spy = vi
        .spyOn(filesystem, 'open')
        .mockImplementation(async (...args: Parameters<typeof filesystem.open>) => {
          const handle = await realOpen(...args);
          if (args[0] === expected.eventsFile) {
            const read = handle.read.bind(handle);
            let changed = false;
            handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
              const result = await read(...readArgs);
              if (!changed) {
                changed = true;
                if (replace) {
                  await filesystem.rename(expected.eventsFile, expected.eventsFile + '.original');
                  await writeFile(expected.eventsFile, exported.serialized);
                } else await filesystem.appendFile(expected.eventsFile, '\n');
              }
              return result;
            }) as typeof handle.read;
          }
          return handle;
        });
      try {
        await expect(readSealedTrace(expected)).rejects.toThrow();
      } finally {
        spy.mockRestore();
      }
    }
  });
});

describe('normative source budget screens on synthetic traces', () => {
  const trace = { ...validSeal, events: exported.events, readbackVerified: true } as ReadTrace;
  it('uses complete generation denominator and includes startup/final uncertainty without subtraction', () => {
    expect(sourceProfile(trace).errors).toEqual([]);
    expect(sourceProfile(trace).spans).toHaveLength(3932);
    expect(sourceProfile(trace).throughput).toBe(131072);
  });
  it.each([125, 125.001, 250])('screens inclusive source-span %s ms', (gap) => {
    const events = exported.events.map((event) => ({ ...event }));
    events.find((event) => event.kind === 'write-enter')!.lo = 0;
    events.find((event) => event.kind === 'write-return')!.hi = gap;
    expect(sourceProfile({ ...trace, events }).errors.includes('source-progress-span-budget')).toBe(
      gap > 125,
    );
  });
  it('rejects slow whole-burst throughput and excessive final span', () => {
    const events = exported.events.map((event) => ({ ...event }));
    events.at(-1)!.hi = 32000;
    expect(sourceProfile({ ...trace, events }).errors).toContain('whole-source-throughput-budget');
    expect(sourceProfile({ ...trace, events }).errors).toContain('source-progress-span-budget');
  });
});

describe('clock-free proof on synthetic callback/ACK clocks (not runtime pilot)', () => {
  function model(delayedFirstWrites = 0) {
    expect(payload.length).toBe(PAYLOAD_BYTES);
    expect(createHash('sha256').update(payload).digest('hex')).toBe(PAYLOAD_SHA256);
    expect(writeEnds).toHaveLength(3931);
    const storage = new TraceStorage();
    storage.append('go', 0, 0, { startedAt: 0 });
    const callbacks = writeEnds.map((to, index) => ({
      id: 'model-session',
      from: index ? writeEnds[index - 1] : 0,
      to,
      lastBoundary: to,
      at: 1000 + (to * 1000) / 131072,
    }));
    const attempts = [];
    let opportunity = 1;
    for (const [index, to] of writeEnds.entries()) {
      const from = index ? writeEnds[index - 1] : 0;
      const at = (to * 1000) / 131072;
      storage.append('scheduler-check', at, at, { due: at, now: at, bytes: from });
      storage.append('write-enter', at, at, { writeIndex: index + 1, from, to, due: at });
      storage.append('write-return', at, at, { writeIndex: index + 1, from, to, accepted: true });
      if (
        opportunity <= 30 &&
        to >= Math.floor((PAYLOAD_BYTES * opportunity) / 31) &&
        (opportunity !== 1 ||
          index >=
            writeEnds.findIndex((end) => end >= Math.floor(PAYLOAD_BYTES / 31)) +
              delayedFirstWrites)
      ) {
        storage.append('checkpoint', at + 0.1, at + 0.1, {
          bytes: to,
          nextDue: (writeEnds[index + 1] * 1000) / 131072,
          token: `C${opportunity}`,
          paused: false,
        });
        const triggerAt = callbacks[index].at + 0.02;
        const ackAt = callbacks[index].at + 0.04;
        attempts.push({
          index: opportunity,
          target: Math.floor((PAYLOAD_BYTES * opportunity) / 31),
          status: 'acked',
          token: `P${String(opportunity).padStart(4, '0')}`,
          before: callbacks[index],
          triggerAt,
          ackAt,
          firstMs: ackAt - triggerAt,
          checkpointSentAt: ackAt,
          atAckBytes: to,
        });
        opportunity++;
      }
    }
    storage.append('complete', 30000, 30000, { bytes: PAYLOAD_BYTES });
    const expected = { ...context, arm: 'hidden-burst-idle' as const };
    const encoded = serializeCompletedTrace(storage, expected);
    const seal = { ...sealFor(encoded, expected), controlBytes: 114 };
    validateSeal(seal, expected, encoded.events);
    const trace = { ...seal, events: encoded.events, readbackVerified: true } as ReadTrace;
    const observed = { payload, callbacks, attempts, unexpected: [] };
    const identity = {
      runId: context.runId,
      sourceId: context.sourceId,
      sessionId: 'model-session',
      arm: expected.arm,
    };
    return { trace, observed, identity };
  }
  it('qualifies exactly thirty original targets, including zero-within-ACK delivery delta', () => {
    const { trace, observed, identity } = model();
    const result = qualify(trace, observed, identity);
    expect(result.errors).toEqual([]);
    expect(result.qualified).toBe(30);
    expect(result.rows.every((row) => row.insideDelta === 0 && !!row.followingCallback)).toBe(true);
  });
  it('rejects exact early-trigger adversary while original target labels remain unchanged', () => {
    const { trace, observed, identity } = model();
    const before = observed.callbacks[14];
    expect(before.to).toBe(1455);
    const triggerAt = before.at + 0.01;
    const ackAt = triggerAt + 0.01;
    const attempts = [
      {
        ...observed.attempts[0],
        before,
        triggerAt,
        ackAt,
        firstMs: ackAt - triggerAt,
        checkpointSentAt: ackAt + 0.01,
        atAckBytes: before.to,
      },
      ...observed.attempts.slice(1),
    ];
    expect(attempts[0].target).toBe(126843);
    const result = qualify(trace, { ...observed, attempts }, identity);
    expect(result.rows[0].causalPacedSegmentQualified).toBe(false);
    expect(result.rows[0].reasons).toContain('target-not-crossed-before-trigger');
  });
  it('requires latest callback even when an older callback already crossed the target; delayed opportunities are legitimate', () => {
    const { trace, observed, identity } = model(1);
    expect(qualify(trace, observed, identity).qualified).toBe(30);
    const first = observed.attempts[0];
    const index = observed.callbacks.indexOf(first.before);
    const before = observed.callbacks[index - 1];
    expect(before.to).toBeGreaterThanOrEqual(first.target);
    const result = qualify(
      trace,
      { ...observed, attempts: [{ ...first, before }, ...observed.attempts.slice(1)] },
      identity,
    );
    expect(result.rows[0].reasons).toContain('not-latest-pre-trigger-callback');
    expect(result.rows[0].reasons).not.toContain('target-not-crossed-before-trigger');
  });
  it('validates complete boundary, byte continuity, nondecreasing callback timestamps and ACK byte count', () => {
    const { trace, observed, identity } = model();
    for (const change of [{ lastBoundary: 0 }, { from: 0 }, { at: observed.callbacks[0].at - 1 }]) {
      const callbacks = observed.callbacks.map((callback) => ({ ...callback }));
      Object.assign(callbacks[10], change);
      expect(qualify(trace, { ...observed, callbacks }, identity).qualified).toBe(0);
    }
    const attempts = [
      { ...observed.attempts[0], atAckBytes: observed.attempts[0].atAckBytes + 1 },
      ...observed.attempts.slice(1),
    ];
    expect(qualify(trace, { ...observed, attempts }, identity).rows[0].reasons).toContain(
      'ack-byte-count-mismatch',
    );
    const callbacks = observed.callbacks.map((callback) => ({ ...callback }));
    callbacks[1].at = callbacks[0].at;
    expect(qualify(trace, { ...observed, callbacks }, identity).qualified).toBe(30);
  });
  it('preserves positive write lateness and a checkpoint later than its unchanged deadline', () => {
    const { trace, observed, identity } = model();
    const events = trace.events.map((event) =>
      event.kind === 'go'
        ? event
        : {
            ...event,
            lo: event.lo + 10,
            hi: event.hi + 10,
            ...(event.kind === 'scheduler-check' ? { now: event.now + 10 } : {}),
          },
    );
    validateTraceEvents(events, { ...context, arm: 'hidden-burst-idle' });
    expect(
      events.some(
        (event) =>
          event.kind === 'checkpoint' && event.nextDue !== null && event.lo > event.nextDue,
      ),
    ).toBe(true);
    const result = qualify({ ...trace, events }, observed, identity);
    expect(result.qualified).toBe(30);
    expect(result.sourceLateness.every((lateness) => lateness > 0)).toBe(true);
  });
  it('rejects zero checkpoint deadlines without a pre-deadline checkpoint eligibility rule', () => {
    const { trace } = model();
    const events = trace.events.map((event) =>
      event.kind === 'checkpoint' ? { ...event, nextDue: 0 } : event,
    );
    expect(() => validateTraceEvents(events, { ...context, arm: 'hidden-burst-idle' })).toThrow(
      'TRACE_CHECKPOINT_SCHEDULE',
    );
  });
  it('rejects stale-only callbacks, missing observed anchor, wrong session, completion, clock inflation and extra opportunities', () => {
    const { trace, observed, identity } = model();
    const first = observed.attempts[0];
    const staleOnly = {
      ...observed,
      callbacks: observed.callbacks.filter((callback) => callback.to <= first.before.to),
    };
    expect(qualify(trace, staleOnly, identity).rows[0].reasons).toContain(
      'missing-incomplete-causal-byte-chain',
    );
    for (const changes of [
      { status: 'timeout' },
      { firstMs: first.firstMs + 1 },
      { checkpointSentAt: first.ackAt - 1 },
      { atAckBytes: PAYLOAD_BYTES },
      { before: { ...first.before, at: first.before.at - 1 } },
      { before: { ...first.before, id: 'other-session' } },
    ]) {
      const attempts = [{ ...first, ...changes }, ...observed.attempts.slice(1)];
      expect(
        qualify(trace, { ...observed, attempts }, identity).rows[0].causalPacedSegmentQualified,
      ).toBe(false);
    }
    expect(
      qualify(trace, { ...observed, attempts: [...observed.attempts, first] }, identity).errors,
    ).toContain('exact-thirty-opportunities-or-controls');
    expect(
      qualify(trace, observed, { ...identity, sourceId: 'different-active-census-source' })
        .qualified,
    ).toBe(0);
  });
  it('explicit pause rejects conservatively even below the progress budget', () => {
    const { trace, observed, identity } = model();
    const index = trace.events.findIndex(
      (event) => event.kind === 'checkpoint' && event.token === 'C16',
    );
    const checkpoint = trace.events[index] as Extract<TraceEvent, { kind: 'checkpoint' }>;
    const events = [
      ...trace.events.slice(0, index),
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'pause-enter' as const,
        bytes: checkpoint.bytes,
        lo: checkpoint.lo - 0.01,
        hi: checkpoint.lo - 0.01,
      },
      { ...checkpoint, paused: true },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'pause-exit' as const,
        lo: checkpoint.hi + 0.01,
        hi: checkpoint.hi + 0.01,
      },
      ...trace.events.slice(index + 1),
    ].map((event, sequence) => ({ ...event, sequence }));
    validateTraceEvents(events, { ...context, mode: 'pause', arm: 'hidden-burst-idle' });
    const result = qualify({ ...trace, events }, observed, identity);
    expect(result.errors).toEqual([]);
    expect(result.rows[15].reasons).toContain('disqualifying-source-state');
  });
});

describe('exact source schedule and mode relations (synthetic traces)', () => {
  function nextUp(value: number) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    view.setBigUint64(0, view.getBigUint64(0) + 1n);
    return view.getFloat64(0);
  }
  it.each(['scheduler-check', 'write-enter'])(
    'rejects fabricated zero and one-ULP changed %s deadlines',
    (kind) => {
      for (const zero of [true, false]) {
        const events = exported.events.map((event) => ({ ...event }));
        const event = events.find((event) => event.kind === kind) as Extract<
          TraceEvent,
          { kind: 'scheduler-check' | 'write-enter' }
        >;
        event.due = zero ? 0 : nextUp(event.due);
        expect(() => validateTraceEvents(events, context)).toThrow();
      }
    },
  );
  it('bounds source now before append lo and validates pace/dispatch fields independently of lateness eligibility', () => {
    const due = (writeEnds[0] * 1000) / 131072;
    const original = exported.events;
    const events = [
      original[0],
      { ...original[1], lo: 0.1, hi: 0.1, now: 0.05 },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'pace-arm' as const,
        due,
        bytes: 0,
        lo: 0.11,
        hi: 0.11,
      },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'timer-dispatch' as const,
        due,
        lo: due,
        hi: due,
      },
      ...original.slice(1),
    ].map((event, sequence) => ({ ...event, sequence }));
    expect(() => validateTraceEvents(events, context)).not.toThrow();
    for (const now of [-1, 0.2]) {
      const changed = events.map((event) => ({ ...event }));
      (changed[1] as Extract<TraceEvent, { kind: 'scheduler-check' }>).now = now;
      expect(() => validateTraceEvents(changed, context)).toThrow();
    }
    for (const index of [2, 3]) {
      const changed = events.map((event) => ({ ...event }));
      (changed[index] as Extract<TraceEvent, { kind: 'pace-arm' | 'timer-dispatch' }>).due = 0;
      expect(() => validateTraceEvents(changed, context)).toThrow();
    }
    const absent = events.map((event) => ({ ...event }));
    delete (absent[3] as Extract<TraceEvent, { kind: 'timer-dispatch' }>).due;
    expect(() => validateTraceEvents(absent, context)).toThrow('TRACE_TIMER_DISPATCH');
  });
  it('validates exact signed rebase origin and all subsequent reconstructed deadlines', () => {
    const offset = (writeEnds[0] * 1000) / 131072;
    const origin = 1.3333333333333333 - offset;
    const events = [
      ...exported.events.slice(0, 3),
      { ...exported.events[3], accepted: false },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'drain-enter' as const,
        writeIndex: 1,
        lo: 1.1,
        hi: 1.1,
      },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'drain-exit' as const,
        lo: 1.25,
        hi: 1.25,
      },
      {
        runId: context.runId,
        sourceId: context.sourceId,
        sequence: 0,
        kind: 'rebase' as const,
        startedAt: origin,
        lo: 1.4,
        hi: 1.4,
      },
      ...exported.events.slice(4).map((event) => ({
        ...event,
        lo: event.lo + origin,
        hi: event.hi + origin,
        ...(event.kind === 'write-enter' || event.kind === 'scheduler-check'
          ? { due: event.due + origin }
          : {}),
        ...(event.kind === 'scheduler-check' ? { now: event.now + origin } : {}),
      })),
    ].map((event, sequence) => ({ ...event, sequence })) as TraceEvent[];
    expect(() => validateTraceEvents(events, { ...context, mode: 'drain' })).not.toThrow();
    const changed = events.map((event) => ({ ...event }));
    (changed[6] as Extract<TraceEvent, { kind: 'rebase' }>).startedAt += 1;
    expect(() => validateTraceEvents(changed, { ...context, mode: 'drain' })).toThrow(
      'TRACE_REBASE_ORIGIN',
    );
  });
  it('accepts genuine slow-only dispatch structure but rejects relabeling in both directions', () => {
    const storage = new TraceStorage();
    storage.append('go', 0, 0, { startedAt: 0 });
    let at = 1;
    for (const [index, to] of writeEnds.entries()) {
      const from = index ? writeEnds[index - 1] : 0;
      const due = (to * 1000) / 131072;
      storage.append('scheduler-check', at, at, { due, now: at, bytes: from });
      storage.append('write-enter', at, at, { writeIndex: index + 1, from, to, due });
      storage.append('write-return', at, at, { writeIndex: index + 1, from, to, accepted: true });
      storage.append('dispatch-wait', at + 0.01, at + 0.01);
      at += 9;
      storage.append('timer-dispatch', at, at);
      at += 0.001;
    }
    storage.append('complete', at, at, { bytes: PAYLOAD_BYTES });
    const encoded = serializeCompletedTrace(storage, { ...context, mode: 'slow' });
    expect(() => validateTraceEvents(encoded.events, { ...context, mode: 'slow' })).not.toThrow();
    expect(() => validateTraceEvents(encoded.events, context)).toThrow('TRACE_DISPATCH_WAIT');
    expect(() => validateTraceEvents(exported.events, { ...context, mode: 'slow' })).toThrow();
  });
});
