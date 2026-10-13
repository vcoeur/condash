import { describe, expect, it } from 'vitest';
import { DEFAULT_PTT_SHORTCUT, pttCommitMatches, pttStartMatches, resolvePttShortcut } from './ptt';

function keyEvent(init: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    repeat: init.repeat ?? false,
  } as KeyboardEvent;
}

describe('resolvePttShortcut', () => {
  it('defaults to Ctrl+Shift+Space when the pref is unset', () => {
    const chord = resolvePttShortcut(undefined);
    expect(chord).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: ' ' });
  });

  it('disables on the empty string (the documented off value)', () => {
    expect(resolvePttShortcut('')).toBeNull();
  });

  it('parses a custom chord verbatim', () => {
    expect(resolvePttShortcut('Ctrl+Shift+D')?.key).toBe('d');
  });

  it('exposes the default spec string', () => {
    expect(DEFAULT_PTT_SHORTCUT).toBe('Ctrl+Shift+Space');
  });
});

describe('pttStartMatches', () => {
  const chord = resolvePttShortcut('Ctrl+Shift+Space');

  it('starts on a matching keydown', () => {
    expect(
      pttStartMatches(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }), chord, false),
    ).toBe(true);
  });

  it('absorbs auto-repeat keydowns while already recording', () => {
    const held = keyEvent({ key: ' ', ctrlKey: true, shiftKey: true, repeat: true });
    expect(pttStartMatches(held, chord, true)).toBe(false);
  });

  it('ignores the event.repeat flag — the recording guard is the absorb mechanism', () => {
    // A repeat flag without the guard must still match (guard honesty).
    const held = keyEvent({ key: ' ', ctrlKey: true, shiftKey: true, repeat: true });
    expect(pttStartMatches(held, chord, false)).toBe(true);
  });

  it('does not start on a wrong chord', () => {
    expect(pttStartMatches(keyEvent({ key: ' ', ctrlKey: true }), chord, false)).toBe(false);
  });

  it('never starts when the chord is disabled', () => {
    expect(pttStartMatches(keyEvent({ key: ' ' }), null, false)).toBe(false);
  });
});

describe('pttCommitMatches', () => {
  const chord = resolvePttShortcut('Ctrl+Shift+Space');

  it('commits on the base key keyup, modifiers already released', () => {
    // The user released Ctrl and Shift before Space — still the commit.
    expect(pttCommitMatches(keyEvent({ key: ' ' }), chord)).toBe(true);
  });

  it('commits with modifiers still held', () => {
    expect(pttCommitMatches(keyEvent({ key: ' ', ctrlKey: true, shiftKey: true }), chord)).toBe(
      true,
    );
  });

  it('ignores unrelated keyups', () => {
    expect(pttCommitMatches(keyEvent({ key: 'Shift' }), chord)).toBe(false);
    expect(pttCommitMatches(keyEvent({ key: 'Control' }), chord)).toBe(false);
    expect(pttCommitMatches(keyEvent({ key: 'a' }), chord)).toBe(false);
  });

  it('never commits when the chord is disabled', () => {
    expect(pttCommitMatches(keyEvent({ key: ' ' }), null)).toBe(false);
  });

  it('matches a letter chord case-insensitively (shift released first)', () => {
    const letterChord = resolvePttShortcut('Ctrl+Shift+D');
    expect(pttCommitMatches(keyEvent({ key: 'd' }), letterChord)).toBe(true);
    expect(pttCommitMatches(keyEvent({ key: 'D' }), letterChord)).toBe(true);
  });
});
