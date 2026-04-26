import { promises as fs } from 'node:fs';

export async function readNote(path: string): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Surface an empty file for editor flows (preferences) where the file may
      // not exist yet; the writeNote drift check uses the same empty string as
      // the "expected on disk" baseline so a first-save creates the file.
      return '';
    }
    throw err;
  }
}
