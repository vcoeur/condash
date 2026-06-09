import { describe, expect, it } from 'vitest';
import { buildRegions } from './regions';

describe('buildRegions', () => {
  it('classifies an H1 on the very first line', () => {
    const raw = '# Title\nbody text\n';
    const regions = buildRegions(raw, 'knowledge');
    expect(regions.regionAt(0)).toBe('h1');
    expect(regions.regionAt(6)).toBe('h1');
    expect(regions.regionAt(raw.indexOf('body'))).toBe('body');
  });

  it('classifies the last line without a trailing newline', () => {
    const raw = 'intro\n## Tail heading';
    const regions = buildRegions(raw, 'knowledge');
    expect(regions.regionAt(0)).toBe('body');
    expect(regions.regionAt(raw.length - 1)).toBe('heading');
  });

  it('handles CRLF line endings', () => {
    const raw = '# Title\r\n\r\n## Section\r\nbody\r\n';
    const regions = buildRegions(raw, 'knowledge');
    expect(regions.regionAt(0)).toBe('h1');
    expect(regions.regionAt(raw.indexOf('## Section'))).toBe('heading');
    expect(regions.regionAt(raw.indexOf('body'))).toBe('body');
  });

  it('only the first H1 is tagged h1; later ones are headings', () => {
    const raw = '# First\n\n# Second\n';
    const regions = buildRegions(raw, 'knowledge');
    expect(regions.regionAt(0)).toBe('h1');
    expect(regions.regionAt(raw.indexOf('# Second'))).toBe('heading');
  });

  it('tags the project meta block after the H1, including blank lines', () => {
    const raw = '# Title\n**Status**: now\n\n**Apps**: condash\n\nBody starts.\n';
    const regions = buildRegions(raw, 'project');
    expect(regions.regionAt(raw.indexOf('**Status**'))).toBe('meta');
    expect(regions.regionAt(raw.indexOf('**Apps**'))).toBe('meta');
    expect(regions.regionAt(raw.indexOf('Body'))).toBe('body');
    expect(regions.metaRange).not.toBeNull();
  });

  it('does not build a meta block for non-project sources', () => {
    const raw = '# Title\n**Status**: now\n';
    const regions = buildRegions(raw, 'knowledge');
    expect(regions.regionAt(raw.indexOf('**Status**'))).toBe('body');
    expect(regions.metaRange).toBeNull();
  });

  it('falls back to body for an offset past the end', () => {
    const regions = buildRegions('# T', 'knowledge');
    expect(regions.regionAt(999)).toBe('body');
  });
});
