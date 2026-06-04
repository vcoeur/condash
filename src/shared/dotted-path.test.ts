import { describe, expect, it } from 'vitest';
import { pickByDottedPath, setByDottedPath } from './dotted-path';

describe('pickByDottedPath', () => {
  const obj = {
    terminal: { logging: { enabled: true } },
    repos: [{ path: '/a' }, { path: '/b' }],
  };

  it('reads a nested key', () => {
    expect(pickByDottedPath(obj, 'terminal.logging.enabled')).toBe(true);
  });

  it('reads an array element via [n]', () => {
    expect(pickByDottedPath(obj, 'repos[1].path')).toBe('/b');
  });

  it('returns undefined for a missing segment', () => {
    expect(pickByDottedPath(obj, 'terminal.missing.key')).toBeUndefined();
  });

  it('returns undefined when indexing a non-array', () => {
    expect(pickByDottedPath(obj, 'terminal[0]')).toBeUndefined();
  });
});

describe('setByDottedPath', () => {
  it('sets a nested key, materialising intermediate objects', () => {
    const obj: Record<string, unknown> = {};
    setByDottedPath(obj, 'audit.thresholds.binary', 5242880);
    expect(obj).toEqual({ audit: { thresholds: { binary: 5242880 } } });
  });

  it('overwrites a non-object intermediate with a fresh object', () => {
    const obj: Record<string, unknown> = { a: 'scalar' };
    setByDottedPath(obj, 'a.b', 1);
    expect(obj).toEqual({ a: { b: 1 } });
  });

  it('leaves sibling keys intact', () => {
    const obj: Record<string, unknown> = { keep: 1, nest: { x: 1 } };
    setByDottedPath(obj, 'nest.y', 2);
    expect(obj).toEqual({ keep: 1, nest: { x: 1, y: 2 } });
  });
});
