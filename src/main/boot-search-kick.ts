interface BootSearchKickWindow {
  isVisible(): boolean;
  once(event: 'ready-to-show' | 'show' | 'focus', listener: () => void): void;
  off(event: 'ready-to-show' | 'show' | 'focus', listener: () => void): void;
}

export interface BootSearchKickHandle {
  /** Clear all listeners and the backstop timer. Safe to call multiple times. */
  clear: () => void;
}

/** Schedule the deferred boot search-index kick.
 *
 * The kick runs once, triggered by the first of `ready-to-show`, `show`,
 * `focus`, or a backstop timeout. Callers should `clear()` the returned
 * handle on conception switch to prevent a stale kick from firing. */
export function scheduleBootSearchKick(options: {
  win: BootSearchKickWindow;
  idleMs: number;
  backstopMs: number;
  onKick: () => void;
}): BootSearchKickHandle {
  let kicked = false;
  let backstop: NodeJS.Timeout | null = null;

  const clear = (): void => {
    if (backstop) {
      clearTimeout(backstop);
      backstop = null;
    }
    options.win.off('ready-to-show', kick);
    options.win.off('show', kick);
    options.win.off('focus', kick);
  };

  const kick = (): void => {
    if (kicked) return;
    kicked = true;
    clear();
    setTimeout(() => options.onKick(), options.idleMs);
  };

  if (options.win.isVisible()) {
    kick();
  } else {
    options.win.once('ready-to-show', kick);
    options.win.once('show', kick);
    options.win.once('focus', kick);
    backstop = setTimeout(kick, options.backstopMs);
  }

  return { clear };
}
