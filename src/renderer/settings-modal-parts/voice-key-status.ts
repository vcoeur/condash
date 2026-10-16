import { createSignal, onCleanup } from 'solid-js';
import type { VoiceCredentialStatus } from '@shared/types';

type SavedKeySnapshot =
  | { phase: 'not-checked' | 'pending' | 'error' }
  | { phase: 'checked'; keys: VoiceCredentialStatus; checkedAt: string };

/** Own each refresh independently of draft edits and discard obsolete replies. */
export function createVoiceKeyStatus(read: () => Promise<VoiceCredentialStatus>) {
  const [snapshot, setSnapshot] = createSignal<SavedKeySnapshot>({ phase: 'not-checked' });
  let revision = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    revision++;
  });
  const refresh = async (): Promise<void> => {
    const request = ++revision;
    setSnapshot({ phase: 'pending' });
    try {
      const keys = await read();
      if (!disposed && request === revision)
        setSnapshot({ phase: 'checked', keys, checkedAt: new Date().toLocaleTimeString() });
    } catch {
      // IPC errors can contain filesystem paths. Do not echo them into credential status.
      if (!disposed && request === revision) setSnapshot({ phase: 'error' });
    }
  };
  return { snapshot, refresh };
}
