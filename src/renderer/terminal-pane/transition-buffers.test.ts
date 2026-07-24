import { describe, expect, it } from 'vitest';
import { createTransitionBuffers } from './transition-buffers';

/** A sink that records what it was handed and reports whether it took it. */
const sink = (accepts: boolean) => {
  const written: string[] = [];
  return {
    written,
    write: (data: string): boolean => {
      if (!accepts) return false;
      written.push(data);
      return true;
    },
  };
};

describe('createTransitionBuffers', () => {
  it('flushes parked chunks to the sink in arrival order, once', () => {
    const buffers = createTransitionBuffers();
    const dom = sink(true);
    buffers.buffer('a', 'one');
    buffers.buffer('a', 'two');
    buffers.flush('a', dom.write);
    expect(dom.written).toEqual(['onetwo']);
    // The bytes are gone from the buffer: a second flush must not duplicate them.
    buffers.flush('a', dom.write);
    expect(dom.written).toEqual(['onetwo']);
  });

  it('keeps the bytes when there is no destination', () => {
    // The silent data drop: the flush used to delete the buffer and then write
    // through an optional chain, so a mount that bailed (its race guard, or a
    // thrown dynamic import) took the pty output with it. Main keeps only a
    // 64 KB tail, so nothing — not even Refresh — can recover those bytes.
    const buffers = createTransitionBuffers();
    const missing = sink(false);
    buffers.buffer('a', 'precious');
    buffers.flush('a', missing.write);
    expect(missing.written).toEqual([]);

    // The next flush, once a Terminal exists, still delivers them.
    const dom = sink(true);
    buffers.flush('a', dom.write);
    expect(dom.written).toEqual(['precious']);
  });

  it('a failed flush keeps ordering for chunks that land after it', () => {
    const buffers = createTransitionBuffers();
    buffers.buffer('a', 'first');
    buffers.flush('a', sink(false).write);
    buffers.buffer('a', 'second');
    const dom = sink(true);
    buffers.flush('a', dom.write);
    expect(dom.written).toEqual(['firstsecond']);
  });

  it('flushing an empty or unknown session never calls the sink', () => {
    const buffers = createTransitionBuffers();
    const dom = sink(true);
    buffers.flush('nobody', dom.write);
    expect(dom.written).toEqual([]);
  });

  it('take consumes the buffer (the replay path owns the bytes from there)', () => {
    const buffers = createTransitionBuffers();
    buffers.buffer('a', 'tail');
    expect(buffers.take('a')).toBe('tail');
    expect(buffers.take('a')).toBe('');
  });

  it('drop and clear discard without a sink', () => {
    const buffers = createTransitionBuffers();
    buffers.buffer('a', 'x');
    buffers.buffer('b', 'y');
    buffers.drop('a');
    expect(buffers.take('a')).toBe('');
    expect(buffers.take('b')).toBe('y');

    buffers.buffer('c', 'z');
    buffers.clear();
    expect(buffers.take('c')).toBe('');
  });

  it('caps a session that never regains a destination, evicting oldest-first', () => {
    // Retaining on a failed flush trades a bounded loss for an unbounded one
    // unless the buffer is capped: a session whose mount never lands has nothing
    // scheduled to flush it again, and a chatty pty would grow it forever.
    const buffers = createTransitionBuffers();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 8; i++) buffers.buffer('a', `${i}${chunk}`);
    const kept = buffers.take('a');
    expect(kept.length).toBeLessThanOrEqual(256 * 1024 + chunk.length + 1);
    // The newest output survives — that is what a terminal shows.
    expect(kept.endsWith(`7${chunk}`)).toBe(true);
    expect(kept.startsWith('0')).toBe(false);
  });

  it('never evicts a lone oversized chunk (one write is better than none)', () => {
    const buffers = createTransitionBuffers();
    const huge = 'y'.repeat(512 * 1024);
    buffers.buffer('a', huge);
    expect(buffers.take('a')).toBe(huge);
  });

  it('restore puts a consumed replay back in front of what arrived since', () => {
    // The promote takes the replay out of the buffer before mounting; if no
    // Terminal comes out of that mount, the bytes must go back — ahead of any
    // chunk that landed while it was in flight, since they predate it.
    const buffers = createTransitionBuffers();
    buffers.buffer('a', 'LIVE');
    buffers.restore('a', 'SNAPSHOT');
    expect(buffers.take('a')).toBe('SNAPSHOTLIVE');
  });

  it('restore of nothing parks nothing', () => {
    const buffers = createTransitionBuffers();
    buffers.restore('a', '');
    expect(buffers.pending('a')).toBe(false);
  });

  it('pending reports whether bytes are waiting', () => {
    const buffers = createTransitionBuffers();
    expect(buffers.pending('a')).toBe(false);
    buffers.buffer('a', 'x');
    expect(buffers.pending('a')).toBe(true);
    buffers.flush('a', () => true);
    expect(buffers.pending('a')).toBe(false);
  });

  it('keeps sessions independent', () => {
    const buffers = createTransitionBuffers();
    buffers.buffer('a', 'A');
    buffers.buffer('b', 'B');
    const dom = sink(true);
    buffers.flush('a', dom.write);
    expect(dom.written).toEqual(['A']);
    expect(buffers.take('b')).toBe('B');
  });
});
