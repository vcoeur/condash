import { describe, expect, it } from 'vitest';
import { categorise, mimeFor } from './file-category';

describe('categorise', () => {
  it('buckets common extensions', () => {
    expect(categorise('readme.md')).toBe('markdown');
    expect(categorise('readme.markdown')).toBe('markdown');
    expect(categorise('doc.pdf')).toBe('pdf');
    expect(categorise('a.json')).toBe('text');
    expect(categorise('styles.css')).toBe('text');
    expect(categorise('img.PNG')).toBe('image');
    expect(categorise('vector.svg')).toBe('image');
    expect(categorise('clip.mp4')).toBe('video');
    expect(categorise('track.mp3')).toBe('audio');
    expect(categorise('archive.zip')).toBe('archive');
    expect(categorise('thing.bin')).toBe('binary');
    expect(categorise('mystery.xyzzy')).toBe('other');
  });

  it('classifies html/htm as their own category, not text', () => {
    expect(categorise('page.html')).toBe('html');
    expect(categorise('page.HTM')).toBe('html');
  });

  it('is case-insensitive on the extension', () => {
    expect(categorise('REPORT.PDF')).toBe('pdf');
    expect(categorise('Page.Html')).toBe('html');
  });

  it('treats a leading-dot name as having no extension (matches node extname)', () => {
    // `.env` is a dotfile, not a `*.env` file — no extension, so `other`.
    expect(categorise('.env')).toBe('other');
    expect(categorise('config.env')).toBe('text');
  });

  it('classifies on the final extension only', () => {
    expect(categorise('archive.tar.gz')).toBe('archive');
    expect(categorise('noext')).toBe('other');
  });
});

describe('mimeFor', () => {
  it('returns a hint for known extensions', () => {
    expect(mimeFor('a.md')).toBe('text/markdown');
    expect(mimeFor('a.png')).toBe('image/png');
    expect(mimeFor('a.html')).toBe('text/html');
    expect(mimeFor('a.css')).toBe('text/css');
  });

  it('returns undefined for unknown extensions', () => {
    expect(mimeFor('a.xyzzy')).toBeUndefined();
  });
});
