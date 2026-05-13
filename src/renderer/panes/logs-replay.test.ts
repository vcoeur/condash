import { describe, expect, it } from 'vitest';
import { buildRenderedItems, searchableText, type ReplaySegmentRenderer } from './logs-replay';
import type { TermLogEvent } from '../../shared/types';

class StubRenderer implements ReplaySegmentRenderer {
  current: string[] = [];
  events: string[] = [];
  start(): void {
    this.current = [];
    this.events.push('start');
  }
  write(data: string): void {
    this.current.push(data);
    this.events.push(`write:${data}`);
  }
  async serialize(): Promise<string> {
    const text = this.current.join('');
    this.events.push(`serialize:${text}`);
    return text;
  }
  dispose(): void {
    this.events.push('dispose');
  }
}

const out = (ts: string, data: string): TermLogEvent => ({
  ts,
  sid: 's',
  side: 'my',
  kind: 'out',
  data,
  len: data.length,
});
const inp = (ts: string, data: string): TermLogEvent => ({
  ts,
  sid: 's',
  side: 'my',
  kind: 'in',
  data,
  len: data.length,
});
const spawn = (ts: string, cmd: string, argv: string[]): TermLogEvent => ({
  ts,
  sid: 's',
  side: 'my',
  kind: 'spawn',
  cmd,
  argv,
});
const exit = (ts: string, code: number): TermLogEvent => ({
  ts,
  sid: 's',
  side: 'my',
  kind: 'exit',
  exitCode: code,
});

describe('buildRenderedItems', () => {
  it('groups contiguous out events into one transcript', async () => {
    const renderer = new StubRenderer();
    const items = await buildRenderedItems([out('t1', 'hello'), out('t2', ' world')], renderer);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: 'transcript',
      text: 'hello world',
      firstTs: 't1',
      segmentId: 0,
    });
    expect(renderer.events).toEqual([
      'start',
      'write:hello',
      'write: world',
      'serialize:hello world',
      'dispose',
    ]);
  });

  it('splits transcripts at every non-out event and assigns sequential segment ids', async () => {
    const renderer = new StubRenderer();
    const items = await buildRenderedItems(
      [
        out('t1', 'A'),
        inp('t2', 'ls\r'),
        out('t3', 'B'),
        out('t4', 'C'),
        spawn('t5', 'bash', ['-l']),
        out('t6', 'D'),
        exit('t7', 0),
      ],
      renderer,
    );
    expect(items.map((i) => i.kind)).toEqual([
      'transcript',
      'event',
      'transcript',
      'event',
      'transcript',
      'event',
    ]);
    const transcripts = items.filter(
      (i): i is Extract<typeof i, { kind: 'transcript' }> => i.kind === 'transcript',
    );
    expect(transcripts.map((t) => t.text)).toEqual(['A', 'BC', 'D']);
    expect(transcripts.map((t) => t.segmentId)).toEqual([0, 1, 2]);
    expect(transcripts.map((t) => t.firstTs)).toEqual(['t1', 't3', 't6']);
  });

  it('passes through all events when no out is present (renderer untouched)', async () => {
    const renderer = new StubRenderer();
    const items = await buildRenderedItems(
      [spawn('t1', 'bash', []), inp('t2', 'foo\r'), exit('t3', 0)],
      renderer,
    );
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.kind === 'event')).toBe(true);
    // Renderer.start() never called; only dispose() at the end.
    expect(renderer.events).toEqual(['dispose']);
  });

  it('returns empty list for empty events', async () => {
    const renderer = new StubRenderer();
    const items = await buildRenderedItems([], renderer);
    expect(items).toEqual([]);
    expect(renderer.events).toEqual(['dispose']);
  });

  it('skips out events with missing data', async () => {
    const renderer = new StubRenderer();
    const items = await buildRenderedItems(
      [{ ts: 't1', sid: 's', side: 'my', kind: 'out' } as TermLogEvent, out('t2', 'hello')],
      renderer,
    );
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe('hello');
  });

  it('groups out events even when separated by other out events with empty data is irrelevant', async () => {
    // Sanity: two out events back-to-back form one segment, period.
    const renderer = new StubRenderer();
    const items = await buildRenderedItems(
      [out('t1', 'a'), out('t2', 'b'), out('t3', 'c')],
      renderer,
    );
    expect(items).toHaveLength(1);
    expect((items[0] as { text: string }).text).toBe('abc');
  });
});

describe('searchableText', () => {
  it('returns transcript text for transcript items', () => {
    expect(searchableText({ kind: 'transcript', text: 'hi', firstTs: 't1', segmentId: 0 })).toBe(
      'hi',
    );
  });

  it('joins cmd + argv for spawn events', () => {
    expect(
      searchableText({ kind: 'event', idx: 0, ev: spawn('t1', '/bin/bash', ['-l', '-i']) }),
    ).toBe('/bin/bash -l -i');
  });

  it('formats exit events', () => {
    expect(searchableText({ kind: 'event', idx: 0, ev: exit('t1', 137) })).toBe('exitCode=137');
  });

  it('returns the canonical text of in events', () => {
    const ev: TermLogEvent = {
      ts: 't1',
      sid: 's',
      side: 'my',
      kind: 'in',
      data: 'ls\r',
      len: 3,
      text: 'ls\r',
    };
    expect(searchableText({ kind: 'event', idx: 0, ev })).toBe('ls\r');
  });
});
