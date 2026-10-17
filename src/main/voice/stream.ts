// Owner admission is independent of the periodically transcribed audio session.
import { VoiceStreamSessionImpl } from './stream-session';
import type { VoiceStreamSessionDeps, VoiceStreamSession } from './stream-session';
export type { VoiceStreamSessionDeps, VoiceStreamSession } from './stream-session';

// ---------------------------------------------------------------------------
// The single-active-session holder (design §3: one stream at a time).
// ---------------------------------------------------------------------------

export interface VoiceStreamReservation {
  readonly ownerId: string;
  cancelled: boolean;
  session: VoiceStreamSessionImpl | null;
}

let active: VoiceStreamReservation | null = null;
const cancelledBeforeStart = new Set<string>();
export const MAX_PRESTART_CANCELLATIONS = 256;
const finishedOwners = new Set<string>();
const MAX_FINISHED_OWNERS = 256;
let admissionClosed = false;

// These are proofs of consumed one-shot starts, not cancellation protection.
// Eviction can only lose duplicate suppression; pending cancel markers never evict.
function rememberFinishedOwner(ownerId: string): void {
  if (finishedOwners.has(ownerId)) return;
  if (finishedOwners.size === MAX_FINISHED_OWNERS) {
    finishedOwners.delete(finishedOwners.values().next().value!);
  }
  finishedOwners.add(ownerId);
}

/** Reserve before settings/config awaits. Overflow closes admission for this
 *  process lifetime: no cancellation protection is ever evicted or timed out. */
export function reserveVoiceStream(
  ownerId: string,
):
  | { ok: true; reservation: VoiceStreamReservation }
  | { ok: false; reason: 'already-active' | 'error'; error?: string } {
  if (cancelledBeforeStart.delete(ownerId)) {
    rememberFinishedOwner(ownerId);
    return { ok: false, reason: 'error', error: 'Dictation recording cancelled.' };
  }
  if (finishedOwners.has(ownerId)) {
    return { ok: false, reason: 'error', error: 'Dictation recording already finished.' };
  }
  if (admissionClosed)
    return {
      ok: false,
      reason: 'error',
      error: 'Dictation admission closed; restart the application.',
    };
  if (active) {
    rememberFinishedOwner(ownerId);
    return { ok: false, reason: 'already-active' };
  }
  const reservation: VoiceStreamReservation = { ownerId, cancelled: false, session: null };
  active = reservation;
  return { ok: true, reservation };
}

export function ownsVoiceStream(reservation: VoiceStreamReservation): boolean {
  return active === reservation && !reservation.cancelled;
}

export function releaseVoiceStream(reservation: VoiceStreamReservation): void {
  rememberFinishedOwner(reservation.ownerId);
  if (active === reservation) active = null;
}

/**
 * Reserve one caption session before asynchronous setup. A failed start
 * releases only its own reservation; it cannot retire a newer owner.
 */
export async function beginVoiceStream(
  deps: VoiceStreamSessionDeps,
  reserved?: VoiceStreamReservation,
): Promise<
  | {
      ok: true;
      session: VoiceStreamSessionImpl;
    }
  | { ok: false; reason: 'already-active' | 'error'; error?: string }
> {
  const admission = reserved
    ? { ok: true as const, reservation: reserved }
    : reserveVoiceStream(deps.ownerId);
  if (!admission.ok) return admission;
  const reservation = admission.reservation;
  if (!ownsVoiceStream(reservation) || reservation.ownerId !== deps.ownerId) {
    return { ok: false, reason: 'error', error: 'Dictation recording cancelled.' };
  }
  let session: VoiceStreamSessionImpl | null = null;
  try {
    session = new VoiceStreamSessionImpl(deps);
    reservation.session = session;
    await Promise.resolve();
    if (!ownsVoiceStream(reservation)) {
      session.cancel();
      return { ok: false, reason: 'error', error: 'Dictation recording cancelled.' };
    }
    return { ok: true, session };
  } catch (err) {
    releaseVoiceStream(reservation);
    session?.cancel();
    return { ok: false, reason: 'error', error: (err as Error).message };
  }
}

/** The active stream's audio tap, or null. */
export function getActiveVoiceStream(ownerId?: string): VoiceStreamSession | null {
  return active && (ownerId === undefined || active.ownerId === ownerId) ? active.session : null;
}

/** Take the active stream out of the slot for a finalising stop. */
export function takeActiveVoiceStream(ownerId: string): VoiceStreamSession | null {
  if (active?.ownerId !== ownerId) return null;
  const session = active.session;
  rememberFinishedOwner(ownerId);
  active.cancelled = true;
  active = null;
  return session;
}

/** Abort the active stream (no commit). */
export function cancelActiveVoiceStream(ownerId: string): void {
  if (active?.ownerId === ownerId) {
    const reservation = active;
    reservation.cancelled = true;
    rememberFinishedOwner(ownerId);
    active = null;
    reservation.session?.cancel();
    return;
  }
  if (finishedOwners.has(ownerId) || cancelledBeforeStart.has(ownerId) || admissionClosed) return;
  if (cancelledBeforeStart.size === MAX_PRESTART_CANCELLATIONS) {
    admissionClosed = true;
    return;
  }
  cancelledBeforeStart.add(ownerId);
}
