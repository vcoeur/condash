import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { TreeRoot } from '@shared/types';

export interface TreeExpansionDeps {
  /** Surface a transient toast in the renderer (used for persist failures). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface TreeExpansion {
  knowledgeExpanded: Accessor<ReadonlySet<string>>;
  resourcesExpanded: Accessor<ReadonlySet<string>>;
  skillsExpanded: Accessor<ReadonlySet<string>>;
  /** Toggle a directory's expanded state in the given pane and persist. */
  toggleTreeExpand: (treeKey: TreeRoot, relPath: string) => void;
  /** Force a directory into the expanded set without toggling — used after
   *  a successful tree mutation so the user can see the new file. */
  expandTreeDir: (treeKey: TreeRoot, relPath: string) => void;
}

/**
 * Per-pane expansion state for the Knowledge / Resources / Skills tree
 * panes (issue #89). Each set holds the directory `relPath`s that are
 * currently expanded; an empty set means the pane is fully collapsed
 * (the on-purpose first-load state). The hydrate-from-IPC then-callback
 * overrides the empty defaults when the user has prior state on disk.
 */
export function createTreeExpansion(deps: TreeExpansionDeps): TreeExpansion {
  const [knowledgeExpanded, setKnowledgeExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [resourcesExpanded, setResourcesExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [skillsExpanded, setSkillsExpanded] = createSignal<ReadonlySet<string>>(new Set());
  void window.condash.getTreeExpansion().then((prefs) => {
    setKnowledgeExpanded(new Set(prefs.knowledge));
    setResourcesExpanded(new Set(prefs.resources));
    setSkillsExpanded(new Set(prefs.skills));
  });

  /** Persist the union of the three pane sets to settings.json.
   *  Fire-and-forget — a write failure surfaces as a toast but the
   *  in-memory state stays authoritative for the session. */
  const persistTreeExpansion = (): void => {
    const prefs = {
      knowledge: Array.from(knowledgeExpanded()),
      resources: Array.from(resourcesExpanded()),
      skills: Array.from(skillsExpanded()),
    };
    void window.condash.setTreeExpansion(prefs).catch((err) => {
      deps.flashToast(`Could not persist tree expansion: ${(err as Error).message}`, 'error');
    });
  };

  const toggleTreeExpand = (treeKey: TreeRoot, relPath: string): void => {
    const setterByKey = {
      knowledge: setKnowledgeExpanded,
      resources: setResourcesExpanded,
      skills: setSkillsExpanded,
    } as const;
    const getterByKey = {
      knowledge: knowledgeExpanded,
      resources: resourcesExpanded,
      skills: skillsExpanded,
    } as const;
    const next = new Set(getterByKey[treeKey]());
    if (next.has(relPath)) next.delete(relPath);
    else next.add(relPath);
    setterByKey[treeKey](next);
    persistTreeExpansion();
  };

  const expandTreeDir = (treeKey: TreeRoot, relPath: string): void => {
    if (relPath === '') return; // root is always expanded; no need to track
    const setterByKey = {
      knowledge: setKnowledgeExpanded,
      resources: setResourcesExpanded,
      skills: setSkillsExpanded,
    } as const;
    const getterByKey = {
      knowledge: knowledgeExpanded,
      resources: resourcesExpanded,
      skills: skillsExpanded,
    } as const;
    const cur = getterByKey[treeKey]();
    if (cur.has(relPath)) return;
    const next = new Set(cur);
    next.add(relPath);
    setterByKey[treeKey](next);
    persistTreeExpansion();
  };

  return {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpanded,
    toggleTreeExpand,
    expandTreeDir,
  };
}
