// Bookkeeping for OSC 133 prompt-boundary decorations.
//
// xterm-mount.ts marks each shell prompt (OSC 133 `A`) with a coloured
// decoration and recolours it with the command's exit code on prompt-end
// (`D`). Two parallel lists track that state: the absolute buffer line of each
// prompt, and the decoration sitting on it. They must stay index-aligned and
// bounded to the scrollback window, or the lists grow for the life of the tab
// (one stale entry per command) — a renderer memory leak that scales with how
// long a terminal has been running.
//
// The logic lives here, free of any `@xterm/*` import, so it is unit-testable
// under the node vitest env (xterm-mount itself needs a DOM + WebGL and can't
// be). mountXterm injects the decoration factory; this module owns the two
// lists and keeps them aligned.

/** The slice of an xterm decoration this tracker needs — just teardown. xterm's
 *  `IDecoration` is structurally assignable. */
export interface PromptDecoration {
  dispose(): void;
}

/**
 * Tracks OSC 133 prompt decorations for one terminal, keeping the prompt-line
 * list and the decoration list strictly index-aligned and trimmed to the
 * scrollback window.
 */
export class PromptDecorations<D extends PromptDecoration> {
  /** Absolute buffer rows where prompts begin, ascending (oldest first). */
  private readonly lines: number[] = [];
  /** Decoration sitting on `lines[i]`, or null when creation failed — the slot
   *  is still kept so the two lists never drift out of alignment. */
  private readonly decorations: (D | null)[] = [];

  /**
   * @param make Factory building a decoration for an absolute buffer `line`
   *   coloured for `exit` (null = no exit code yet). Returns null when the
   *   decoration could not be registered; the slot is preserved regardless.
   */
  constructor(private readonly make: (line: number, exit: number | null) => D | null) {}

  /**
   * Record a prompt-start (OSC 133 `A`) at absolute buffer `line`, coloured for
   * the previous command's `exit` code, then trim prompts scrolled past `baseY`.
   */
  start(line: number, exit: number | null, baseY: number): void {
    this.lines.push(line);
    this.decorations.push(this.make(line, exit));
    this.trim(baseY);
  }

  /**
   * Record a prompt-end (OSC 133 `D`): recolour the most recent prompt's
   * decoration with the resolved `exit` code, replacing it **in place** (the
   * leak fix — the old code pushed a second entry per command).
   */
  end(exit: number | null): void {
    const last = this.lines.length - 1;
    if (last < 0) return;
    this.decorations[last]?.dispose();
    this.decorations[last] = this.make(this.lines[last], exit);
  }

  /** Drop prompts that have scrolled out of the scrollback window
   *  (`line < baseY`), disposing their decorations. */
  trim(baseY: number): void {
    while (this.lines.length > 0 && this.lines[0] < baseY) {
      this.lines.shift();
      this.decorations.shift()?.dispose();
    }
  }

  /** Absolute buffer rows of the tracked prompts, ascending. */
  promptLines(): readonly number[] {
    return this.lines;
  }

  /** Number of tracked decorations — always equal to `promptLines().length`.
   *  Exposed for the alignment regression test. */
  get size(): number {
    return this.decorations.length;
  }

  /** Dispose every decoration and clear both lists (terminal teardown). */
  dispose(): void {
    for (const dec of this.decorations) dec?.dispose();
    this.decorations.length = 0;
    this.lines.length = 0;
  }
}
