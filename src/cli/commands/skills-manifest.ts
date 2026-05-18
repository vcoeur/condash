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
 * Drop manifest entries whose shipped skill source has been removed from the
 * template bundle. Mutates `manifest` and returns the dropped entries so the
 * install report can surface them.
 */
export function pruneSourceMissingSkillEntries(
  manifest: Manifest,
  shipped: ShippedSkill[],
): { skill: string; relPath: string; shippedVersion: string }[] {
  const shippedNames = new Set(shipped.map((s) => s.name));
  const dropped: { skill: string; relPath: string; shippedVersion: string }[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (shippedNames.has(name)) continue;
    for (const [relPath, fileEntry] of Object.entries(entry.source)) {
      dropped.push({ skill: name, relPath, shippedVersion: fileEntry.shippedVersion });
    }
    delete manifest.skills[name];
  }
  return dropped;
}
