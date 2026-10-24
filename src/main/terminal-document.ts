import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalDocumentPath } from '../shared/terminal-document-uri';
import { requirePathUnder } from './path-bounds';

/** Use the terminal-owned cwd, then retain the native viewers' conception boundary. */
export async function resolveTerminalDocument(
  uri: string,
  cwd: string,
  conceptionPath: string,
): Promise<string> {
  const pathname = terminalDocumentPath(uri);
  if (pathname === null) throw new Error('Not a local Markdown or MDX link');
  const nativePath = /^file:/i.test(uri) ? fileURLToPath(uri) : pathname;
  const real = await requirePathUnder(resolve(cwd, nativePath), conceptionPath);
  if (!/\.(md|mdx)$/i.test(real) || !(await stat(real)).isFile()) {
    throw new Error('Terminal document link must resolve to a Markdown or MDX file');
  }
  return real;
}
