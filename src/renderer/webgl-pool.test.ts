import { describe, expect, it } from 'vitest';
import { WebglContextPool, type WebglSlot } from './webgl-pool';

/** A test slot that records attach/detach calls and its live state. */
function makeSlot(name: string, log: string[]): WebglSlot & { live: boolean } {
  const slot = {
    name,
    live: false,
    attach() {
      slot.live = true;
      log.push(`attach:${name}`);
    },
    detach() {
      slot.live = false;
      log.push(`detach:${name}`);
    },
  };
  return slot;
}

describe('WebglContextPool', () => {
  it('attaches on touch and reports live count', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(3);
    const a = makeSlot('a', log);
    pool.touch(a);
    expect(a.live).toBe(true);
    expect(pool.liveCount).toBe(1);
    expect(pool.has(a)).toBe(true);
    expect(log).toEqual(['attach:a']);
  });

  it('touching an already-live slot does not re-attach', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(3);
    const a = makeSlot('a', log);
    pool.touch(a);
    pool.touch(a);
    expect(log).toEqual(['attach:a']);
    expect(pool.liveCount).toBe(1);
  });

  it('caps live contexts and evicts the least-recently-touched', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(2);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    const c = makeSlot('c', log);
    pool.touch(a);
    pool.touch(b);
    pool.touch(c); // over cap → evict LRU (a)
    expect(pool.liveCount).toBe(2);
    expect(a.live).toBe(false);
    expect(b.live).toBe(true);
    expect(c.live).toBe(true);
    expect(log).toEqual(['attach:a', 'attach:b', 'attach:c', 'detach:a']);
  });

  it('touch refreshes recency so the truly-oldest is evicted', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(2);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    const c = makeSlot('c', log);
    pool.touch(a);
    pool.touch(b);
    pool.touch(a); // a is now MRU
    pool.touch(c); // over cap → evict b (now LRU), not a
    expect(a.live).toBe(true);
    expect(b.live).toBe(false);
    expect(c.live).toBe(true);
  });

  it('never evicts a shown (visible) slot', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(2);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    const c = makeSlot('c', log);
    pool.show(a); // visible, protected
    pool.touch(b);
    pool.touch(c); // over cap → must evict b, not the protected a
    expect(a.live).toBe(true);
    expect(b.live).toBe(false);
    expect(c.live).toBe(true);
  });

  it('may exceed cap when more slots are shown than capacity (fails safe)', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(2);
    const slots = ['a', 'b', 'c'].map((n) => makeSlot(n, log));
    for (const slot of slots) pool.show(slot);
    // All three are protected: none can be evicted, so all stay live.
    expect(pool.liveCount).toBe(3);
    expect(slots.every((slot) => slot.live)).toBe(true);
  });

  it('hide un-protects and lets the slot be evicted on the next touch', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(2);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    const c = makeSlot('c', log);
    pool.show(a); // protected, MRU
    pool.touch(b); // live {a, b}, under cap
    expect(pool.liveCount).toBe(2);
    pool.hide(a); // a is now evictable and the least-recently-touched
    pool.touch(c); // over cap → evict a (LRU, no longer protected), keep b
    expect(a.live).toBe(false);
    expect(b.live).toBe(true);
    expect(c.live).toBe(true);
    expect(pool.liveCount).toBe(2);
  });

  it('a protected slot fully consuming the cap evicts a newly-touched slot (fails safe)', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(1);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    pool.show(a); // protected, fills the single slot
    pool.touch(b); // over cap and a can't be evicted → b is dropped again
    expect(a.live).toBe(true);
    expect(b.live).toBe(false);
    expect(pool.liveCount).toBe(1);
  });

  it('remove drops a slot without calling detach', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(3);
    const a = makeSlot('a', log);
    pool.touch(a);
    pool.remove(a);
    expect(pool.has(a)).toBe(false);
    expect(pool.liveCount).toBe(0);
    // detach not called by remove — caller's own teardown owns disposal.
    expect(log).toEqual(['attach:a']);
  });

  it('re-showing an evicted slot re-attaches a fresh context', () => {
    const log: string[] = [];
    const pool = new WebglContextPool(1);
    const a = makeSlot('a', log);
    const b = makeSlot('b', log);
    pool.touch(a);
    pool.touch(b); // evicts a
    expect(a.live).toBe(false);
    pool.show(a); // brings a back, evicts b
    expect(a.live).toBe(true);
    expect(b.live).toBe(false);
    expect(log).toEqual(['attach:a', 'attach:b', 'detach:a', 'attach:a', 'detach:b']);
  });
});
