/**
 * IO-shaped facade over `shared/header.ts`. The pure parser, validator,
 * regexes, and folder-slug helpers live in `shared/header.ts`; this
 * module exists so any caller that needs to read a README header off
 * disk has one stop instead of three (the previous cli/header.ts +
 * main/header-fs.ts shims used to drift independently).
 */
import { promises as fs } from 'node:fs';
import { parseHeader, type HeaderFields } from '../shared/header';

/** Read + parse the header block of an item README. */
export async function readHeader(readmePath: string): Promise<HeaderFields> {
  const raw = await fs.readFile(readmePath, 'utf8');
  return parseHeader(raw);
}
