import { describe, expect, it } from 'vitest';
import { displayName, type Tab } from './types';

function tab(overrides: Partial<Tab>): Tab {
  return {
    id: 'id',
    side: 'my',
    column: 'left',
    label: 'shell',
    ...overrides,
  } satisfies Tab;
}

describe('displayName', () => {
  it('falls back to the spawn-time label when no cwd / customName is set', () => {
    expect(displayName(tab({ label: 'shell' }))).toBe('shell');
  });

  it('uses the cwd basename when the shell emitted OSC 7', () => {
    expect(displayName(tab({ label: 'shell', cwd: '/home/alice/src/vcoeur/condash' }))).toBe(
      'condash',
    );
  });

  it('customName always wins, even over cwd', () => {
    expect(displayName(tab({ label: 'shell', customName: 'my-term', cwd: '/tmp/foo' }))).toBe(
      'my-term',
    );
  });

  describe('termTitle (OSC 0/2 harness title)', () => {
    it('shows the harness title on a pinned tab — cwd is suppressed — over the label', () => {
      expect(
        displayName(tab({ label: 'claude', pinned: true, termTitle: 'Ask about the weather' })),
      ).toBe('Ask about the weather');
    });

    it('cwd basename wins over termTitle on an unpinned tab', () => {
      expect(
        displayName(
          tab({
            label: 'shell',
            cwd: '/home/alice/src/vcoeur/condash',
            termTitle: 'alice@vostro: ~',
          }),
        ),
      ).toBe('condash');
    });

    it('termTitle wins over the spawn label when there is no cwd', () => {
      expect(displayName(tab({ label: 'shell', termTitle: 'building docs' }))).toBe(
        'building docs',
      );
    });

    it('customName still wins over termTitle', () => {
      expect(
        displayName(tab({ label: 'claude', pinned: true, customName: 'my-term', termTitle: 'x' })),
      ).toBe('my-term');
    });
  });

  describe('pinned', () => {
    it('keeps the spawn-time label when the shell emits OSC 7', () => {
      expect(
        displayName(
          tab({
            label: 'condash · my-feature',
            pinned: true,
            cwd: '/home/alice/src/worktrees/my-feature/condash',
          }),
        ),
      ).toBe('condash · my-feature');
    });

    it('still defers to customName when the user renamed', () => {
      expect(
        displayName(
          tab({ label: 'lambda', pinned: true, customName: 'session 7', cwd: '/tmp/foo' }),
        ),
      ).toBe('session 7');
    });
  });
});
