/**
 * Docs-drift guard: `docs/reference/config.md` must keep up with the config
 * schemas.
 *
 * AGENTS.md promises "the schema in `src/main/config-schema.ts` and the public
 * reference (`docs/reference/config.md`) must agree on every release", but
 * nothing in CI used to read the reference — a key added or renamed in
 * `config-schema.ts` could ship undocumented forever. This test derives the
 * top-level key set from the two zod schemas (`globalSettingsSchema`,
 * `conceptionConfigSchema`) and asserts each key appears (backticked) in the
 * doc's "All config keys" table, plus a scope-column agreement check against
 * `SCOPE_OF` from `config-scope.ts`. Assertions search for tokens, not whole
 * lines, so prose rewrites don't trip them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalSettingsSchema, conceptionConfigSchema } from '../src/main/config-schema';
import { SCOPE_OF } from '../src/main/config-scope';

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');

function readDoc(relPath: string): string {
  return readFileSync(join(DOCS_DIR, relPath), 'utf8');
}

describe('docs/reference/config.md keeps up with the config schemas', () => {
  const configMd = readDoc('reference/config.md');

  // Top-level keys are the union of the two disjoint schema key sets.
  const schemaKeys = new Set([
    ...Object.keys(globalSettingsSchema.shape),
    ...Object.keys(conceptionConfigSchema.shape),
  ]);

  // The `## All config keys { #all-config-keys }` section — the one table this
  // guard watches. Scoped so a backticked key in earlier prose (e.g. the
  // "At a glance" table) can't stand in for a missing row. Empty string when
  // the section is absent; the tests below fail loudly on that.
  const tableSection = (() => {
    const lines = configMd.split('\n');
    const start = lines.findIndex((line) => line.includes('## All config keys'));
    if (start === -1) return '';
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
  })();

  it('guards a non-trivial key set and a real table', () => {
    expect(schemaKeys.size).toBeGreaterThan(10);
    expect(
      tableSection,
      'docs/reference/config.md should carry an "All config keys" section',
    ).toBeTruthy();
    // A rewrite that deletes the whole table must fail, not pass vacuously.
    const rowCount = tableSection.split('\n').filter((line) => line.startsWith('| `')).length;
    expect(rowCount).toBeGreaterThanOrEqual(schemaKeys.size - 1); // $schema_doc has no table row
  });

  it('documents every schema key in the All-config-keys table', () => {
    for (const key of schemaKeys) {
      expect(
        configMd,
        `docs/reference/config.md should document the schema key '${key}'`,
      ).toContain(`\`${key}\``);
    }
  });

  it('keeps the scope column in agreement with SCOPE_OF', () => {
    expect(
      tableSection,
      'docs/reference/config.md should carry an "All config keys" section',
    ).toBeTruthy();
    for (const key of schemaKeys) {
      // `$schema_doc` is documented as valid in both files; no single scope.
      if (key === '$schema_doc') continue;
      const scope = SCOPE_OF[key];
      expect(
        scope,
        `schema key '${key}' has no entry in SCOPE_OF (src/main/config-scope.ts) — ` +
          `add it there and to the config.md scope column`,
      ).toBeTruthy();
      const row = tableSection.split('\n').find((line) => line.startsWith(`| \`${key}\``));
      expect(row, `docs/reference/config.md should carry a table row for '${key}'`).toBeTruthy();
      expect(
        row,
        `docs/reference/config.md row for '${key}' should carry scope '${scope}'`,
      ).toContain(scope);
    }
  });
});
