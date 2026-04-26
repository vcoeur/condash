import { promises as fs } from 'node:fs';

export async function readNote(path: string): Promise<string> {
  return fs.readFile(path, 'utf8');
}
