/**
 * `readHeader` for the Electron main process — thin fs+parse wrapper that
 * keeps the rest of `main/` from reaching across into `cli/`. The pure
 * parser lives in `shared/header.ts`.
 */
import { promises as fs } from 'node:fs';
import { parseHeader, type HeaderFields } from '../shared/header';

export async function readHeader(readmePath: string): Promise<HeaderFields> {
  const raw = await fs.readFile(readmePath, 'utf8');
  return parseHeader(raw);
}
