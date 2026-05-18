import { createSignal, onCleanup } from 'solid-js';

export type ToastKind = 'success' | 'error' | 'info';
export type ToastState = { msg: string; kind: ToastKind } | null;

export interface UseToast {
  toast: () => ToastState;
  flashToast: (msg: string, kind?: ToastKind) => void;
}

/** Transient toast banner. Tracks the active dismiss timer so a fast
 *  burst of flashes — or App teardown within the 4 s window — doesn't
 *  leave a callback running against a disposed signal. */
export function useToast(): UseToast {
  const [toast, setToast] = createSignal<ToastState>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const flashToast = (msg: string, kind: ToastKind = 'info'): void => {
    setToast({ msg, kind });
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      setToast((cur) => (cur && cur.msg === msg ? null : cur));
    }, 4000);
  };
  onCleanup(() => {
    if (toastTimer !== null) clearTimeout(toastTimer);
  });
  return { toast, flashToast };
}
