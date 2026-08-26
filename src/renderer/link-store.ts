// Manual terminal-tab ↔ project-card link store.
//
// One persisted map of many-to-many relations — `slug → sid → record` —
// mediating every surface that reads or writes a link: the card's Link button
// and Linked-tabs block, the Active-tab filter, the tab strip's hover popover
// and context menu, and the controller's focus mirror / prune / re-point
// lifecycle hooks. Cross-pane (cards + tab strip + filter), so it lives here
// beside `star-store.ts` rather than under `terminal-pane/`.
//
// Storage is the namespaced, versioned localStorage key
// `condash:term:links:v1`, read synchronously at module load and written
// synchronously on every mutation — links are discrete user gestures, not
// drag-driven, so the `scheduleWrite` debounce in `persistence.ts` would only
// delay them. The try/catch swallow of a quota / sandbox failure degrades to
// "no links" for the session, exactly like `readMeta`.
//
// The map is project-first because the card is the user's anchor; the tab-side
// reverse lookup ("which projects is this tab linked to?") is derived on read
// over the same map, so no second persisted copy can drift. Every write is
// atomic and additive — one relation added, one removed, or all of a tab's
// removed — never a replace, so nothing is ever displaced (many-to-many).

import { createSignal } from 'solid-js';

export const LINKS_KEY = 'condash:term:links:v1';

/** One relation (slug × sid): the tab's display name captured at link time and
 *  a diagnostics-only timestamp. No colour — the tab is undecorated by
 *  contract, and the card's family hue is computed by the card itself. */
export interface LinkRecord {
  label: string;
  linkedAt: string;
}

/** Persisted map: project slug → terminal session id → record. */
export type LinkMap = Record<string, Record<string, LinkRecord>>;

/** The focused terminal session, mirrored by the controller. */
interface ActiveSession {
  sid: string;
  label: string;
  /** Project slug main's mention scan derived from this tab's output. Rides the
   *  focus mirror because every consumer of a suggestion is already reading the
   *  focused session — the card's Link button asks "is the tab I would link
   *  suggesting me?", which is one question, not two. Undefined when the scan
   *  found no clear leader. */
  suggestedProject?: string;
}

/** A fresh, prototype-less dictionary. The persisted bytes are untrusted, and a
 *  bracket assignment on a plain object with a key like `__proto__` invokes the
 *  prototype setter instead of creating an own property — every map the store
 *  builds, on the read path AND the mutation paths, is null-prototype so a
 *  hostile key lands as — and stays — a plain own property. */
function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function readLinks(): LinkMap {
  try {
    const raw = localStorage.getItem(LINKS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    // Deep-validate the whole shape, entry by entry: the key is versioned but
    // the bytes are not ours to trust (a hand edit, an older app's shape, a
    // truncated write), and every read here feeds live rendering — a single
    // malformed nested value must not throw in a card or tab row. Malformed
    // entries are dropped wholesale; only well-formed relations survive.
    const out = emptyRecord<Record<string, LinkRecord>>();
    for (const [slug, bySid] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof bySid !== 'object' || bySid === null || Array.isArray(bySid)) continue;
      const records = emptyRecord<LinkRecord>();
      for (const [sid, record] of Object.entries(bySid as Record<string, unknown>)) {
        if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
        const { label, linkedAt } = record as Record<string, unknown>;
        if (typeof label !== 'string' || typeof linkedAt !== 'string') continue;
        records[sid] = { label, linkedAt };
      }
      if (Object.keys(records).length > 0) out[slug] = records;
    }
    return out;
  } catch {
    // Unavailable storage or an unparseable payload — degrade to "no links".
    return {};
  }
}

function writeLinks(map: LinkMap): void {
  try {
    localStorage.setItem(LINKS_KEY, JSON.stringify(map));
  } catch {
    /* quota / sandboxed env — degrade to "no links" for the session */
  }
}

const [byProject, setByProject] = createSignal<LinkMap>(readLinks());
const [active, setActive] = createSignal<ActiveSession | null>(null);

/** The focused terminal session, or null when none is. Drives the Link
 *  button's disabled state, the Active-tab filter, and the strong card
 *  decoration. */
export function activeSession(): {
  sid: string;
  label: string;
  suggestedProject?: string;
} | null {
  return active();
}

/** Mirror the focused session into the store. Equality-guarded on sid, label
 *  and suggestion so the controller's 2.5 s memory-sampler broadcast — which
 *  re-runs the mirror effect without changing the focus — publishes nothing.
 *  The suggestion is part of the guard, not exempt from it: the mention scan
 *  rides that same 2.5 s tick, so a settled tab re-publishes the same value
 *  every tick and only a real change may ripple out. */
export function setActiveSession(
  next: { sid: string; label: string; suggestedProject?: string } | null,
): void {
  const current = active();
  if (current === next) return;
  if (
    current &&
    next &&
    current.sid === next.sid &&
    current.label === next.label &&
    current.suggestedProject === next.suggestedProject
  ) {
    return;
  }
  setActive(next);
}

/** Every tab this project links, in link order — the card rows + the
 *  any/active decoration decision. */
export function linkedTabsOf(slug: string): { sid: string; label: string }[] {
  const bySid = byProject()[slug];
  if (!bySid) return [];
  return Object.entries(bySid).map(([sid, record]) => ({ sid, label: record.label }));
}

/** Every project this tab links, derived over the one map — the tab hover
 *  popover list and the context-menu unlink items. */
export function linkedProjectsOf(sid: string): { slug: string; label: string }[] {
  const map = byProject();
  const out: { slug: string; label: string }[] = [];
  for (const slug of Object.keys(map)) {
    const record = map[slug][sid];
    if (record) out.push({ slug, label: record.label });
  }
  return out;
}

/** Strong decoration: true while the focused session is one of `slug`'s linked
 *  tabs. Reactive through both the map and the mirror. */
export function isLinkedToActiveTab(slug: string): boolean {
  const current = active();
  if (!current) return false;
  return Boolean(byProject()[slug]?.[current.sid]);
}

/** Add one relation. A no-op when the pair already exists — linking is
 *  additive and idempotent, never a replace. */
export function linkProject(slug: string, sid: string, label: string): void {
  const prev = byProject();
  if (prev[slug]?.[sid]) return;
  const next = Object.assign(emptyRecord<Record<string, LinkRecord>>(), prev);
  const bySid = Object.assign(emptyRecord<LinkRecord>(), prev[slug]);
  bySid[sid] = { label, linkedAt: new Date().toISOString() };
  next[slug] = bySid;
  setByProject(next);
  writeLinks(next);
}

/** Remove exactly one relation; every other relation of both endpoints
 *  survives. A slug left with no tabs drops out of the map. */
export function unlinkProjectFromTab(slug: string, sid: string): void {
  const prev = byProject();
  const bySid = prev[slug];
  if (!bySid || !bySid[sid]) return;
  const rest = emptyRecord<LinkRecord>();
  for (const [key, record] of Object.entries(bySid)) {
    if (key !== sid) rest[key] = record;
  }
  const next = Object.assign(emptyRecord<Record<string, LinkRecord>>(), prev);
  if (Object.keys(rest).length === 0) delete next[slug];
  else next[slug] = rest;
  setByProject(next);
  writeLinks(next);
}

/** Remove every relation of `sid` — the context menu's "Unlink all projects".
 *  A no-op when the tab has none. */
export function unlinkAllForTab(sid: string): void {
  const prev = byProject();
  let changed = false;
  const next = emptyRecord<Record<string, LinkRecord>>();
  for (const slug of Object.keys(prev)) {
    const bySid = prev[slug];
    if (bySid[sid]) {
      changed = true;
      const rest = emptyRecord<LinkRecord>();
      for (const [key, record] of Object.entries(bySid)) {
        if (key !== sid) rest[key] = record;
      }
      if (Object.keys(rest).length > 0) next[slug] = rest;
    } else {
      next[slug] = bySid;
    }
  }
  if (!changed) return;
  setByProject(next);
  writeLinks(next);
}

/** Default for `pruneLinks`'s protected set, so the common call passes nothing. */
const NO_PROTECTED: ReadonlySet<string> = new Set<string>();

/** Drop every relation whose sid is no longer in the live roster — runs at the
 *  end of each reconcile pass, so a closed tab and a fresh boot (no live
 *  sessions) both clear their relations in one write. Idempotent: a broadcast
 *  that changed nothing publishes nothing.
 *
 *  `protectedSids` are exempt for one call: the controller passes its
 *  restarting set, because a Restart's replacement-only broadcast can arrive
 *  before the `termRestart` IPC reply resolves — without the exemption the
 *  prune would delete the old sid's relations a moment before `repointSid`
 *  moves them onto the new one. The repoint itself (in the same success path)
 *  is what ends the protection. */
export function pruneLinks(
  liveSids: ReadonlySet<string>,
  protectedSids: ReadonlySet<string> = NO_PROTECTED,
): void {
  const prev = byProject();
  let changed = false;
  const next = emptyRecord<Record<string, LinkRecord>>();
  for (const slug of Object.keys(prev)) {
    const bySid = prev[slug];
    const rest = emptyRecord<LinkRecord>();
    for (const [sid, record] of Object.entries(bySid)) {
      if (liveSids.has(sid) || protectedSids.has(sid)) rest[sid] = record;
      else changed = true;
    }
    if (Object.keys(rest).length > 0) next[slug] = rest;
  }
  if (!changed) return;
  setByProject(next);
  writeLinks(next);
}

/** Move every relation of `oldSid` onto `newSid`, preserving labels — the
 *  restartTab success path, because a Restart spawns a fresh session id and the
 *  links would otherwise die like a close. Collision policy is deterministic:
 *  the MOVED record wins — a Restart is the same link continuing on a fresh
 *  sid, so it outranks a record that could only have been made against an id
 *  that did not exist yet (in practice a fresh sid never collides). */
export function repointSid(oldSid: string, newSid: string): void {
  if (oldSid === newSid) return;
  const prev = byProject();
  let changed = false;
  const next = emptyRecord<Record<string, LinkRecord>>();
  for (const slug of Object.keys(prev)) {
    const bySid = prev[slug];
    if (bySid[oldSid]) {
      changed = true;
      const moved = bySid[oldSid];
      const rest = emptyRecord<LinkRecord>();
      for (const [sid, record] of Object.entries(bySid)) {
        if (sid === oldSid || sid === newSid) continue;
        rest[sid] = record;
      }
      rest[newSid] = moved;
      next[slug] = rest;
    } else {
      next[slug] = bySid;
    }
  }
  if (!changed) return;
  setByProject(next);
  writeLinks(next);
}
