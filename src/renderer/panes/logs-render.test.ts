import { describe, expect, it } from 'vitest';
import { AnsiUp } from 'ansi_up';
import { expandCursorForward } from './logs-render';

const ESC = '\x1b';

describe('expandCursorForward', () => {
  it('replaces CSI 1 C with one space', () => {
    expect(expandCursorForward(`A${ESC}[1CB`)).toBe('A B');
  });

  it('replaces CSI 5 C with five spaces', () => {
    expect(expandCursorForward(`A${ESC}[5CB`)).toBe('A     B');
  });

  it('treats missing count as 1 (CSI default)', () => {
    expect(expandCursorForward(`A${ESC}[CB`)).toBe('A B');
  });

  it('treats CSI 0 C as 1 (degenerate; matches xterm)', () => {
    expect(expandCursorForward(`A${ESC}[0CB`)).toBe('A B');
  });

  it('leaves SGR sequences untouched', () => {
    const sgr = `${ESC}[31mred${ESC}[0m`;
    expect(expandCursorForward(sgr)).toBe(sgr);
  });

  it('leaves other CSI sequences untouched (ansi_up drops them later)', () => {
    expect(expandCursorForward(`A${ESC}[3DB`)).toBe(`A${ESC}[3DB`);
    expect(expandCursorForward(`A${ESC}[?2004hB`)).toBe(`A${ESC}[?2004hB`);
    expect(expandCursorForward(`A${ESC}[5;10HB`)).toBe(`A${ESC}[5;10HB`);
  });

  it('handles real SerializeAddon-style output — bug witness', () => {
    expect(expandCursorForward(`Baked${ESC}[1Cfor${ESC}[1C2s`)).toBe('Baked for 2s');
  });

  it('handles a captured Claude-Code response line', () => {
    const raw = `${ESC}[38;5;231m●${ESC}[1C${ESC}[0mHello!${ESC}[1CReady${ESC}[1Cwhen${ESC}[1Cyou${ESC}[1Care.`;
    expect(expandCursorForward(raw)).toBe(`${ESC}[38;5;231m● ${ESC}[0mHello! Ready when you are.`);
  });

  it('expansion + ansi_up produces visible spaces in the rendered HTML', () => {
    const raw = `Baked${ESC}[1Cfor${ESC}[1C2s`;
    const ansi = new AnsiUp();
    ansi.use_classes = false;
    expect(ansi.ansi_to_html(expandCursorForward(raw))).toBe('Baked for 2s');
  });

  it('expansion + ansi_up preserves SGR span and inter-word spacing', () => {
    const raw = `${ESC}[38;5;231m●${ESC}[1C${ESC}[0mHello!${ESC}[1CReady`;
    const ansi = new AnsiUp();
    ansi.use_classes = false;
    const html = ansi.ansi_to_html(expandCursorForward(raw));
    expect(html).toContain('●');
    expect(html).toContain('Hello! Ready');
  });
});
