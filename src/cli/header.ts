/**
 * IO-shaped facade over `shared/header.ts`. The pure parser, validator,
 * regexes, and folder-slug helpers all live in `shared/`; this module exists
 * only to keep the historical CLI/main import paths stable and to host the
 * one helper that does filesystem IO (`readHeader`).
 */
import { promises as fs } from 'node:fs';
import { parseHeader, type HeaderFields } from '../shared/header';

export {
  parseHeader,
  validateHeader,
  isItemFolderName,
  itemFolderRegex,
  ENUMS,
  META_LINE,
  HEADING2,
  KNOWN_KINDS,
  type HeaderFields,
  type HeaderValidation,
  type HeaderIssue,
} from '../shared/header';

/** Read + parse the header block of an item README. */
export async function readHeader(readmePath: string): Promise<HeaderFields> {
  const raw = await fs.readFile(readmePath, 'utf8');
  return parseHeader(raw);
}
