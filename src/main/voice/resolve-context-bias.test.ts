import { describe, expect, it } from 'vitest';
import { MAX_CONTEXT_BIAS, resolveContextBias } from './resolve-context-bias';

describe('resolveContextBias', () => {
  it('audio-context keeps canonical handles and user phrases only with the same cap', () => {
    expect(
      resolveContextBias(
        [' Word ', 'word'],
        [
          { handle: 'canonical', name: 'Display', aliases: ['Alias'] },
          'tools/quelle',
          { section: 'skip' },
        ],
        true,
      ),
    ).toEqual(['Word', 'canonical', 'quelle']);
    expect(
      resolveContextBias(
        Array.from({ length: 101 }, (_, i) => `phrase-${i}`),
        [{ handle: 'extra' }],
        true,
      ),
    ).toHaveLength(100);
  });
  it('returns the user list unchanged when no repositories are configured', () => {
    expect(resolveContextBias(['condash', ' knoten '], undefined)).toEqual(['condash', 'knoten']);
    expect(resolveContextBias(undefined, undefined)).toEqual([]);
  });

  it('merges user phrases first, then handles, names, and aliases', () => {
    const bias = resolveContextBias(
      ['myproject'],
      [
        { name: 'condash', handle: undefined, aliases: ['cd'] },
        { handle: 'knoten', name: 'knoten-vault' },
        { name: 'tools/quelle', aliases: [] },
      ],
    );
    // The derived handle (`quelle`) and the display name (`tools/quelle`) are
    // distinct vocabulary — both are worth a slot.
    expect(bias).toEqual([
      'myproject',
      'condash',
      'cd',
      'knoten',
      'knoten-vault',
      'quelle',
      'tools/quelle',
    ]);
  });

  it('trims, drops empties, and deduplicates case-insensitively', () => {
    const bias = resolveContextBias(
      [' vcoeur ', '', 'Vcoeur', '  '],
      [{ handle: 'VCOEUR', name: ' vcoeur.com ', aliases: ['', 'Vcoeur'] }],
    );
    expect(bias).toEqual(['vcoeur', 'vcoeur.com']);
  });

  it('derives the handle from the path when the row carries neither handle nor name', () => {
    const bias = resolveContextBias([], [{ path: '/workspace/example/ExampleApp' }]);
    expect(bias).toEqual(['exampleapp']);
  });

  it('caps at 100 entries with user phrases taking priority', () => {
    const userBias = Array.from({ length: 60 }, (_, i) => `user-${i}`);
    const repositories = Array.from({ length: 80 }, (_, i) => ({ handle: `app-${i}` }));
    const bias = resolveContextBias(userBias, repositories);
    expect(bias).toHaveLength(MAX_CONTEXT_BIAS);
    expect(bias[0]).toBe('user-0');
    expect(bias[59]).toBe('user-59');
    expect(bias).toEqual([...userBias, ...Array.from({ length: 40 }, (_, i) => `app-${i}`)]);
  });
});

describe('resolveContextBias — raw config union', () => {
  it('reads bare-string rows and skips section markers', () => {
    const bias = resolveContextBias([], ['condash', { section: 'personal' }, { handle: 'knoten' }]);
    expect(bias).toEqual(['condash', 'knoten']);
  });
});
