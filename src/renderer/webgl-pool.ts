// Caps the number of live WebGL renderer contexts across all mounted terminals.
//
// xterm's WebglAddon holds one GPU context per terminal, and condash eagerly
// mounts every open "my terms" tab (terminal-pane/controller.ts) — so N tabs
// meant N live contexts. Past the browser's ~16-context ceiling the GPU
// force-loses contexts, triggering the WebglAddon's context-loss retry churn
// (review finding F1 — the "slow with many terminals" cliff).
//
// This pool keeps at most `capacity` contexts live. Currently-visible terminals
// are "shown" (protected) and never evicted; when a newly-touched terminal
// pushes the live count over capacity, the least-recently-touched *unprotected*
// terminal's context is disposed — xterm reverts to its DOM renderer with no
// data loss. Re-showing that terminal re-attaches a fresh context.
//
// The module is free of any `@xterm/*` import so it unit-tests under the node
// vitest env; the caller (xterm-mount.ts) injects the attach/detach closures
// that build and dispose the real WebglAddon.

/** The GPU-context lifecycle hooks for one terminal. `attach` builds + loads a
 *  fresh WebglAddon; `detach` disposes it (reverting to xterm's DOM renderer).
 *  Both must be idempotent — the pool may call `attach` on an already-live slot
 *  or `detach` on an already-detached one. */
export interface WebglSlot {
  attach(): void;
  detach(): void;
}

/** Default live-context cap. Well under the browser's ~16-context ceiling to
 *  leave headroom for the app's other GPU canvases (mermaid, image previews). */
export const DEFAULT_WEBGL_CAPACITY = 8;

/**
 * LRU pool bounding the number of live terminal WebGL contexts. Visible
 * terminals are shielded from eviction; hidden ones age out least-recently-used
 * first once the cap is exceeded.
 */
export class WebglContextPool {
  private readonly capacity: number;
  /** Slots holding a live context, least-recently-touched first (MRU at end). */
  private readonly order: WebglSlot[] = [];
  /** Membership mirror of `order` for O(1) liveness checks. */
  private readonly live = new Set<WebglSlot>();
  /** Visible slots — never evicted while present here. */
  private readonly shown = new Set<WebglSlot>();

  constructor(capacity: number = DEFAULT_WEBGL_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Ensure `slot` holds a live context and mark it most-recently-used, then
   *  evict least-recently-used unprotected slots back down to capacity. Used on
   *  mount and on context-loss recovery. */
  touch(slot: WebglSlot): void {
    this.promote(slot);
    this.evict();
  }

  /** Mark `slot` visible: give it a context, make it MRU, and shield it from
   *  eviction until `hide`. */
  show(slot: WebglSlot): void {
    this.shown.add(slot);
    this.promote(slot);
    this.evict();
  }

  /** Mark `slot` hidden: it keeps its context (LRU decides when to drop it) but
   *  is no longer shielded from eviction. */
  hide(slot: WebglSlot): void {
    if (!this.shown.delete(slot)) return;
    this.evict();
  }

  /** Drop `slot` from the pool entirely (terminal disposed). Does not call
   *  `detach` — the caller's own teardown disposes the addon. */
  remove(slot: WebglSlot): void {
    this.shown.delete(slot);
    if (this.live.delete(slot)) {
      const index = this.order.indexOf(slot);
      if (index >= 0) this.order.splice(index, 1);
    }
  }

  /** Whether `slot` currently holds a live context (per the pool's bookkeeping;
   *  a GPU context-loss doesn't clear this — the slot is still pool-live and
   *  eligible to rebuild). */
  has(slot: WebglSlot): boolean {
    return this.live.has(slot);
  }

  /** Live-context count — for tests and diagnostics. */
  get liveCount(): number {
    return this.live.size;
  }

  private promote(slot: WebglSlot): void {
    const index = this.order.indexOf(slot);
    if (index >= 0) this.order.splice(index, 1);
    this.order.push(slot);
    if (!this.live.has(slot)) {
      this.live.add(slot);
      slot.attach();
    }
  }

  private evict(): void {
    let index = 0;
    // Walk oldest→newest, disposing unprotected slots until back under cap.
    // Protected (visible) slots are skipped, so a pathological >capacity visible
    // count fails safe (never disposes a visible terminal's context).
    while (this.live.size > this.capacity && index < this.order.length) {
      const slot = this.order[index];
      if (this.shown.has(slot)) {
        index++;
        continue;
      }
      this.order.splice(index, 1);
      this.live.delete(slot);
      slot.detach();
    }
  }
}

/** Process-wide pool shared by every mounted terminal. */
export const webglPool = new WebglContextPool();
