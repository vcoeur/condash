import { describe, expect, it } from 'vitest';
import { PromptDecorations } from './prompt-decorations';

/** Minimal stand-in for an xterm decoration: records its own disposal. */
class FakeDecoration {
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

/** A factory that hands out FakeDecorations and keeps every one it made, so a
 *  test can assert which were disposed. */
function trackingFactory() {
  const made: FakeDecoration[] = [];
  const make = (): FakeDecoration => {
    const dec = new FakeDecoration();
    made.push(dec);
    return dec;
  };
  return { made, make };
}

describe('PromptDecorations', () => {
  it('keeps the decoration list aligned with prompt lines across A/D cycles', () => {
    const { make } = trackingFactory();
    const prompts = new PromptDecorations<FakeDecoration>(make);
    // 500 command cycles, baseY pinned at 0 so nothing scrolls out — this is the
    // regression: the old code grew the decoration list by 2 per command.
    for (let i = 0; i < 500; i++) {
      prompts.start(i, null, 0); // OSC 133 A
      prompts.end(0); // OSC 133 D
    }
    expect(prompts.size).toBe(prompts.promptLines().length);
    expect(prompts.size).toBe(500);
  });

  it('disposes the replaced decoration on prompt-end — no orphaned decoration', () => {
    const { made, make } = trackingFactory();
    const prompts = new PromptDecorations<FakeDecoration>(make);
    prompts.start(0, null, 0); // creates made[0]
    prompts.end(0); // disposes made[0], creates made[1] in its place
    expect(made[0].disposed).toBe(true);
    expect(made[1].disposed).toBe(false);
    expect(prompts.size).toBe(1);
  });

  it('trims prompts that scroll out of scrollback and disposes their decorations', () => {
    const { made, make } = trackingFactory();
    const prompts = new PromptDecorations<FakeDecoration>(make);
    prompts.start(0, null, 0);
    prompts.start(1, null, 0);
    prompts.start(2, null, 0);
    expect(prompts.size).toBe(3);
    // baseY advances to 2 → prompts on lines 0 and 1 are gone.
    prompts.trim(2);
    expect(prompts.promptLines()).toEqual([2]);
    expect(prompts.size).toBe(1);
    expect(made[0].disposed).toBe(true);
    expect(made[1].disposed).toBe(true);
    expect(made[2].disposed).toBe(false);
  });

  it('stays aligned when the factory returns null (decoration registration failed)', () => {
    const prompts = new PromptDecorations<FakeDecoration>(() => null);
    prompts.start(0, null, 0);
    prompts.end(0);
    prompts.start(1, null, 0);
    expect(prompts.size).toBe(prompts.promptLines().length);
    expect(prompts.size).toBe(2);
  });

  it('end() is a no-op before any prompt-start', () => {
    const { made, make } = trackingFactory();
    const prompts = new PromptDecorations<FakeDecoration>(make);
    expect(() => prompts.end(0)).not.toThrow();
    expect(prompts.size).toBe(0);
    expect(made).toHaveLength(0);
  });

  it('dispose() releases every decoration and clears both lists', () => {
    const { made, make } = trackingFactory();
    const prompts = new PromptDecorations<FakeDecoration>(make);
    prompts.start(0, null, 0);
    prompts.start(1, null, 0);
    prompts.dispose();
    expect(prompts.size).toBe(0);
    expect(prompts.promptLines()).toEqual([]);
    expect(made.every((d) => d.disposed)).toBe(true);
  });
});
