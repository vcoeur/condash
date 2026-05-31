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

  describe('autoTitle (capability 3)', () => {
    it('uses autoTitle over the cwd basename and label', () => {
      expect(
        displayName(
          tab({
            label: 'shell',
            cwd: '/home/alice/src/vcoeur/condash',
            autoTitle: 'fixing logs CLI',
          }),
        ),
      ).toBe('fixing logs CLI');
    });

    it('customName still wins over autoTitle', () => {
      expect(
        displayName(tab({ label: 'shell', customName: 'my-term', autoTitle: 'fixing logs CLI' })),
      ).toBe('my-term');
    });

    it('autoTitle wins even when the tab is pinned (it is a deliberate title)', () => {
      expect(displayName(tab({ label: 'lambda', pinned: true, autoTitle: 'running tests' }))).toBe(
        'running tests',
      );
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
