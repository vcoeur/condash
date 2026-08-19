/**
 * Skill-namespace manifest mutations. The schema (`v3`), the on-disk
 * read/write/migrate, and the hashing/diff helpers all live in
 * `install-shared.ts` (shared with the top-level files lane). This module
 * collects the skill-namespace mutations that are not generic enough to
 * belong there.
 */

import type { Manifest } from './install-shared';
import type { ShippedSkill } from './skills-shipped';

/**
 * Drop manifest entries the template bundle no longer ships. Two cases, and
 * both leave a ghost that `skills status` would otherwise have to report:
 *
 *   - the whole skill is gone from the bundle — the entry and its files go;
 *   - the skill is still shipped but one of its files is not (renamed or
 *     dropped in a later layout) — that file's entry alone goes.
 *
 * Mutates `manifest`. Returns the dropped file entries for the install report,
 * plus the names of the skills that were dropped whole, since only those have
 * an on-disk directory left to clean up.
 */
export function pruneSourceMissingSkillEntries(
  manifest: Manifest,
  shipped: ShippedSkill[],
): {
  entries: { skill: string; relPath: string; shippedVersion: string }[];
  removedSkills: string[];
} {
  const shippedByName = new Map(shipped.map((s) => [s.name, s]));
  const entries: { skill: string; relPath: string; shippedVersion: string }[] = [];
  const removedSkills: string[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    const ship = shippedByName.get(name);
    if (!ship) {
      for (const [relPath, fileEntry] of Object.entries(entry.source)) {
        entries.push({ skill: name, relPath, shippedVersion: fileEntry.shippedVersion });
      }
      delete manifest.skills[name];
      removedSkills.push(name);
      continue;
    }
    for (const [relPath, fileEntry] of Object.entries(entry.source)) {
      if (ship.files.includes(relPath)) continue;
      entries.push({ skill: name, relPath, shippedVersion: fileEntry.shippedVersion });
      delete entry.source[relPath];
    }
  }
  return { entries, removedSkills };
}
