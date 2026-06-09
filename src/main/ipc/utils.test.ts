/**
 * Tests for the shared IPC decoders' newest members: the sender guard
 * (`requireMainWindowSender`) and the optional string-array decoder. The
 * guard is exercised on plain objects shaped like `IpcMainInvokeEvent` —
 * no Electron runtime needed.
 */
import { describe, expect, it } from 'vitest';
import { requireMainWindowSender, requireOptionalStringArray } from './utils';

function makeEvent(overrides: {
  senderType?: string;
  sender?: null;
  senderFrame?: null;
  url?: string;
  parent?: unknown;
}): Parameters<typeof requireMainWindowSender>[0] {
  if (overrides.sender === null) {
    return { sender: null, senderFrame: { url: 'file:///app/index.html', parent: null } };
  }
  const sender = { getType: () => overrides.senderType ?? 'window' };
  if (overrides.senderFrame === null) {
    return { sender, senderFrame: null };
  }
  return {
    sender,
    senderFrame: {
      url: overrides.url ?? 'file:///app/dist/index.html',
      parent: overrides.parent !== undefined ? overrides.parent : null,
    },
  };
}

describe('requireMainWindowSender', () => {
  it('accepts the packaged app: window sender, top frame, file:// url', () => {
    expect(() => requireMainWindowSender(makeEvent({}))).not.toThrow();
  });

  it('accepts the dev server origin', () => {
    expect(() =>
      requireMainWindowSender(makeEvent({ url: 'http://localhost:5600/' })),
    ).not.toThrow();
  });

  it('rejects a webview guest sender', () => {
    expect(() => requireMainWindowSender(makeEvent({ senderType: 'webview' }))).toThrow(
      /not an app window/,
    );
  });

  it('rejects a missing sender', () => {
    expect(() => requireMainWindowSender(makeEvent({ sender: null }))).toThrow(/not an app window/);
  });

  it('rejects a destroyed/missing sender frame', () => {
    expect(() => requireMainWindowSender(makeEvent({ senderFrame: null }))).toThrow(
      /not the top frame/,
    );
  });

  it('rejects a subframe (iframe) sender', () => {
    expect(() => requireMainWindowSender(makeEvent({ parent: {} }))).toThrow(/not the top frame/);
  });

  it('rejects a non-app origin', () => {
    expect(() => requireMainWindowSender(makeEvent({ url: 'https://evil.example/' }))).toThrow(
      /not an app origin/,
    );
  });

  it('rejects a port-prefix lookalike of the dev origin', () => {
    expect(() => requireMainWindowSender(makeEvent({ url: 'http://localhost:56001/' }))).toThrow(
      /not an app origin/,
    );
  });
});

describe('requireOptionalStringArray', () => {
  it('passes undefined and null through as undefined', () => {
    expect(requireOptionalStringArray('search', undefined)).toBeUndefined();
    expect(requireOptionalStringArray('search', null)).toBeUndefined();
  });

  it('returns a valid string array unchanged', () => {
    expect(requireOptionalStringArray('search', ['a', 'b'])).toEqual(['a', 'b']);
    expect(requireOptionalStringArray('search', [])).toEqual([]);
  });

  it('rejects non-arrays and arrays with non-string elements', () => {
    expect(() => requireOptionalStringArray('search', 'nope')).toThrow(
      /search: expected an array of strings/,
    );
    expect(() => requireOptionalStringArray('search', ['a', 1])).toThrow(
      /search: expected an array of strings/,
    );
  });
});
