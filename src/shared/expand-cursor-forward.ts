/**
 * Pre-processing for saved terminal-log `.txt` files before they go to
 * `ansi_up` (renderer) or before substring-matching in global search
 * (main).
 *
 * `@xterm/addon-serialize` encodes runs of empty cells as `CSI <N> C`
 * (cursor-forward) rather than literal spaces — see SerializeAddon.ts:404.
 * `ansi_up` is an SGR-only parser and silently drops every non-SGR CSI
 * sequence, so without this step every space `SerializeAddon` emitted as
 * `[NC` collapses to zero width in the rendered HTML and adjacent words
 * mash together (`Baked for 2s` → `Bakedfor2s`). The same expansion has
 * to run *before* the global-search substring match so a user typing
 * "Baked for" finds the hit.
 *
 * We expand only `CSI <N> C` here; the other non-SGR escapes
 * `SerializeAddon` emits (cursor-up/down/back, mode sets) carry no
 * meaning on a static text rendering, and ansi_up's existing
 * drop-on-sight behaviour is correct for them.
 */

const CSI_CUF = /\x1b\[(\d*)C/g;

export function expandCursorForward(text: string): string {
  return text.replace(CSI_CUF, (_, n: string) => {
    const parsed = parseInt(n || '1', 10);
    const count = Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
    return ' '.repeat(count);
  });
}
