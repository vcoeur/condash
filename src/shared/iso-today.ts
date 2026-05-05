/** Today as `YYYY-MM-DD` in the local timezone. Three byte-identical copies
 *  used to live in `src/main/mutate.ts`, `src/cli/commands/projects.ts`, and
 *  `src/cli/commands/knowledge.ts`. */
export function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
