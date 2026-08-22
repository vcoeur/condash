/**
 * Unit tests for the link store — the persisted many-to-many map behind the
 * card ↔ terminal-tab links.
 *
 * The store reads localStorage once at module load, so each test gets a fresh
 * module instance (`vi.resetModules()` + dynamic import) against a cleared
 * fake storage — the same pattern `bootstrap.test.ts` uses for its memoized
 * module state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Fake localStorage installed before the store module evaluates (vi.hoisted
 *  runs ahead of the imports). */
const lsMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const mock = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => {
      store.clear();
    },
  };
  (globalThis as unknown as Record<string, unknown>).localStorage = mock;
  return mock;
});

type Store = typeof import('./link-store');

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('./link-store');
}

afterEach(() => {
  lsMock.clear();
});

beforeEach(() => {
  lsMock.clear();
});

describe('linkProject / linkedTabsOf — atomic add, never replace', () => {
  it('records one relation with sid + label', async () => {
    const store = await freshStore();
    store.linkProject('2026-08-19-nodum-settings-core', 't-1', 'nodum · main');
    expect(store.linkedTabsOf('2026-08-19-nodum-settings-core')).toEqual([
      { sid: 't-1', label: 'nodum · main' },
    ]);
  });

  it('is many-to-many — a project links two tabs, both kept', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'nodum · main');
    store.linkProject('slug-a', 't-2', 'nodum · nodum-settings-core');
    expect(store.linkedTabsOf('slug-a')).toEqual([
      { sid: 't-1', label: 'nodum · main' },
      { sid: 't-2', label: 'nodum · nodum-settings-core' },
    ]);
  });

  it('is many-to-many — one tab links two projects', async () => {
    const store = await freshStore();
    store.linkProject('slug-p', 't-1', 'nodum · main');
    store.linkProject('slug-q', 't-1', 'nodum · main');
    expect(store.linkedProjectsOf('t-1')).toEqual([
      { slug: 'slug-p', label: 'nodum · main' },
      { slug: 'slug-q', label: 'nodum · main' },
    ]);
  });

  it('re-linking the same pair is a no-op', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'label');
    store.linkProject('slug-a', 't-1', 'label');
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'label' }]);
  });

  it('linking a different tab to a linked project adds, never replaces', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-a', 't-2', 'two');
    expect(store.linkedTabsOf('slug-a')).toHaveLength(2);
    expect(store.linkedTabsOf('slug-a').map((t) => t.sid)).toEqual(['t-1', 't-2']);
  });
});

describe('unlinkProjectFromTab / unlinkAllForTab — atomic remove', () => {
  it('unlinks exactly one relation; siblings survive', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-a', 't-2', 'two');
    store.unlinkProjectFromTab('slug-a', 't-1');
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-2', label: 'two' }]);
    // The reverse lookup dropped the relation too.
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
    expect(store.linkedProjectsOf('t-2')).toEqual([{ slug: 'slug-a', label: 'two' }]);
  });

  it('drops the slug entry entirely when its last tab unlinks', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.unlinkProjectFromTab('slug-a', 't-1');
    expect(store.linkedTabsOf('slug-a')).toEqual([]);
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
  });

  it('unlink of an absent pair is a no-op', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.unlinkProjectFromTab('slug-a', 't-2');
    store.unlinkProjectFromTab('slug-b', 't-1');
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'one' }]);
  });

  it('unlinkAllForTab drops every relation of the sid', async () => {
    const store = await freshStore();
    store.linkProject('slug-p', 't-1', 'one');
    store.linkProject('slug-q', 't-1', 'one');
    store.linkProject('slug-q', 't-2', 'two');
    store.unlinkAllForTab('t-1');
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
    expect(store.linkedProjectsOf('t-2')).toEqual([{ slug: 'slug-q', label: 'two' }]);
    // The cards lost their rows for that tab only.
    expect(store.linkedTabsOf('slug-p')).toEqual([]);
    expect(store.linkedTabsOf('slug-q')).toEqual([{ sid: 't-2', label: 'two' }]);
  });

  it('unlinkAll on a tab with no relations is a no-op', async () => {
    const store = await freshStore();
    store.linkProject('slug-p', 't-1', 'one');
    store.unlinkAllForTab('t-2');
    expect(store.linkedTabsOf('slug-p')).toEqual([{ sid: 't-1', label: 'one' }]);
  });
});

describe('reverse lookup — linkedProjectsOf', () => {
  it('returns both projects for a doubly-linked tab, in link order', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'x');
    store.linkProject('slug-b', 't-1', 'x');
    store.linkProject('slug-b', 't-2', 'y');
    expect(store.linkedProjectsOf('t-1').map((p) => p.slug)).toEqual(['slug-a', 'slug-b']);
    expect(store.linkedProjectsOf('t-2').map((p) => p.slug)).toEqual(['slug-b']);
    expect(store.linkedProjectsOf('t-3')).toEqual([]);
  });
});

describe('lifecycle — pruneLinks and repointSid', () => {
  it('prune drops every relation whose sid left the roster, both directions', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-a', 't-2', 'two');
    store.linkProject('slug-b', 't-1', 'one');
    store.pruneLinks(new Set(['t-2']));
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-2', label: 'two' }]);
    expect(store.linkedTabsOf('slug-b')).toEqual([]);
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
  });

  it('prune with the roster unchanged is a no-op (no write, no notify)', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.pruneLinks(new Set(['t-1']));
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'one' }]);
  });

  it('prune with an empty roster clears everything — the fresh-boot case', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-b', 't-2', 'two');
    store.pruneLinks(new Set());
    expect(store.linkedTabsOf('slug-a')).toEqual([]);
    expect(store.linkedTabsOf('slug-b')).toEqual([]);
  });

  it('prune exempts protected sids — the restart race window', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-b', 't-2', 'two');
    // The old sid is mid-restart: its relations survive a replacement-only
    // roster, other dropped sids still go.
    store.pruneLinks(new Set(['t-2']), new Set(['t-1']));
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'one' }]);
    expect(store.linkedTabsOf('slug-b')).toEqual([{ sid: 't-2', label: 'two' }]);
    // Once repoint moves them onto the (now live) new sid, the protection is
    // moot — the old sid has nothing left and the new one is in the roster.
    store.repointSid('t-1', 't-9');
    store.pruneLinks(new Set(['t-2', 't-9']), new Set(['t-1']));
    expect(store.linkedProjectsOf('t-9')).toEqual([{ slug: 'slug-a', label: 'one' }]);
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
  });

  it('repoint moves all relations of the old sid to the new one, labels preserved', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'nodum · main');
    store.linkProject('slug-b', 't-1', 'nodum · main');
    store.repointSid('t-1', 't-9');
    expect(store.linkedProjectsOf('t-9').map((p) => p.slug)).toEqual(['slug-a', 'slug-b']);
    expect(store.linkedProjectsOf('t-1')).toEqual([]);
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-9', label: 'nodum · main' }]);
  });

  it('repoint leaves unrelated relations alone and no-ops on equal ids', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    store.linkProject('slug-b', 't-2', 'two');
    store.repointSid('t-1', 't-1');
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'one' }]);
    expect(store.linkedTabsOf('slug-b')).toEqual([{ sid: 't-2', label: 'two' }]);
  });

  it('repoint onto an occupied destination is deterministic — the moved record wins', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'old-label');
    // A record that could only exist against a sid the restart mints fresh —
    // the corner is pinned so the collision policy cannot silently flip.
    store.linkProject('slug-a', 't-9', 'stale-label');
    store.repointSid('t-1', 't-9');
    expect(store.linkedTabsOf('slug-a')).toEqual([{ sid: 't-9', label: 'old-label' }]);
  });
});

describe('persistence', () => {
  it('round-trips through localStorage under the namespaced key', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'one');
    const raw = lsMock.getItem('condash:term:links:v1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      'slug-a': { 't-1': { label: 'one', linkedAt: expect.any(String) } },
    });
    // A fresh module instance reads the same map back.
    const reloaded = await freshStore();
    expect(reloaded.linkedTabsOf('slug-a')).toEqual([{ sid: 't-1', label: 'one' }]);
  });

  it('an unparseable or foreign stored shape reads as empty', async () => {
    lsMock.setItem('condash:term:links:v1', 'not-json');
    const store = await freshStore();
    expect(store.linkedTabsOf('anything')).toEqual([]);
    lsMock.setItem('condash:term:links:v1', JSON.stringify(['not', 'a', 'map']));
    const store2 = await freshStore();
    expect(store2.linkedProjectsOf('t-1')).toEqual([]);
  });

  it('drops malformed nested entries instead of exposing them to rendering', async () => {
    // A hand edit / truncated write / older shape must not let a card or tab
    // row dereference garbage: null slugs, null records, and non-string fields
    // are dropped wholesale; only well-formed relations survive.
    lsMock.setItem(
      'condash:term:links:v1',
      JSON.stringify({
        'slug-null': null,
        'slug-list': ['x'],
        'slug-bad-record': { 't-1': null, 't-2': 'junk', 't-3': { label: 42, linkedAt: 'y' } },
        'slug-good': {
          't-1': { label: 'ok', linkedAt: '2026-08-22T00:00:00.000Z' },
        },
      }),
    );
    const store = await freshStore();
    expect(store.linkedTabsOf('slug-null')).toEqual([]);
    expect(store.linkedTabsOf('slug-list')).toEqual([]);
    expect(store.linkedTabsOf('slug-bad-record')).toEqual([]);
    expect(store.linkedTabsOf('slug-good')).toEqual([{ sid: 't-1', label: 'ok' }]);
  });

  it('treats __proto__ keys as plain own properties, never prototype pollution', async () => {
    // Project slugs are date-prefixed and sids are main-minted, so these keys
    // cannot occur legitimately — but the persisted bytes are untrusted, and a
    // hand-edited `__proto__` must read back as an ordinary relation without
    // touching any object's prototype. Seeded as raw JSON text: an object
    // LITERAL `{ __proto__: x }` sets the prototype instead of an own key.
    lsMock.setItem(
      'condash:term:links:v1',
      '{"__proto__":{"t-1":{"label":"evil","linkedAt":"2026-08-22T00:00:00.000Z"}},' +
        '"slug-a":{"__proto__":{"label":"evil","linkedAt":"2026-08-22T00:00:00.000Z"},' +
        '"t-2":{"label":"ok","linkedAt":"2026-08-22T00:00:00.000Z"}}}',
    );
    const store = await freshStore();
    expect(store.linkedTabsOf('__proto__')).toEqual([{ sid: 't-1', label: 'evil' }]);
    // The nested `__proto__` sid is structurally valid, so it is kept as an
    // ordinary own property beside `t-2` — never swallowed by the prototype.
    expect(store.linkedTabsOf('slug-a')).toEqual([
      { sid: '__proto__', label: 'evil' },
      { sid: 't-2', label: 'ok' },
    ]);
    expect(store.linkedProjectsOf('t-1')).toEqual([{ slug: '__proto__', label: 'evil' }]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();

    // The MUTATION paths build maps the same way: a prune whose live set
    // includes the hostile sid must carry the hostile-key relations through
    // untouched (a dead sid is still pruned normally — see the other tests).
    store.pruneLinks(new Set(['t-1', 't-2', '__proto__']));
    expect(store.linkedTabsOf('__proto__')).toEqual([{ sid: 't-1', label: 'evil' }]);
    expect(store.linkedTabsOf('slug-a')).toEqual([
      { sid: '__proto__', label: 'evil' },
      { sid: 't-2', label: 'ok' },
    ]);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('activeSession mirror', () => {
  it('starts null and follows setActiveSession', async () => {
    const store = await freshStore();
    expect(store.activeSession()).toBeNull();
    store.setActiveSession({ sid: 't-1', label: 'nodum · main' });
    expect(store.activeSession()).toEqual({ sid: 't-1', label: 'nodum · main' });
    store.setActiveSession(null);
    expect(store.activeSession()).toBeNull();
  });

  it('is equality-guarded — an unchanged mirror publishes nothing observable', async () => {
    const store = await freshStore();
    store.setActiveSession({ sid: 't-1', label: 'label' });
    const before = store.activeSession();
    store.setActiveSession({ sid: 't-1', label: 'label' });
    expect(store.activeSession()).toBe(before);
    // A label change (tab renamed while focused) does publish.
    store.setActiveSession({ sid: 't-1', label: 'renamed' });
    expect(store.activeSession()).toEqual({ sid: 't-1', label: 'renamed' });
  });

  it('drives the strong decoration read', async () => {
    const store = await freshStore();
    store.linkProject('slug-a', 't-1', 'label');
    expect(store.isLinkedToActiveTab('slug-a')).toBe(false);
    store.setActiveSession({ sid: 't-1', label: 'label' });
    expect(store.isLinkedToActiveTab('slug-a')).toBe(true);
    store.setActiveSession({ sid: 't-2', label: 'other' });
    expect(store.isLinkedToActiveTab('slug-a')).toBe(false);
    store.setActiveSession(null);
    expect(store.isLinkedToActiveTab('slug-a')).toBe(false);
  });
});
