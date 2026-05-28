import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { SkillScope, TreeRoot } from '@shared/types';

export interface TreeExpansionDeps {
  /** Surface a transient toast in the renderer (used for persist failures). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface TreeExpansion {
  knowledgeExpanded: Accessor<ReadonlySet<string>>;
  resourcesExpanded: Accessor<ReadonlySet<string>>;
  /** Per-scope expanded set for the Skills pane. */
  skillsExpandedForScope: (scope: SkillScope) => Accessor<ReadonlySet<string>>;
  /** Toggle a directory's expanded state in the given pane and persist.
   *  When `treeKey === 'skills'`, `skillScope` is required. */
  toggleTreeExpand: (treeKey: TreeRoot, relPath: string, skillScope?: SkillScope) => void;
  /** Force a directory into the expanded set without toggling — used after
   *  a successful tree mutation so the user can see the new file. */
  expandTreeDir: (treeKey: TreeRoot, relPath: string, skillScope?: SkillScope) => void;
}

/**
 * Per-pane expansion state for the Knowledge / Resources / Skills tree
 * panes (issue #89). Each set holds the directory `relPath`s that are
 * currently expanded; an empty set means the pane is fully collapsed
 * (the on-purpose first-load state). The hydrate-from-IPC then-callback
 * overrides the empty defaults when the user has prior state on disk.
 *
 * The Skills pane carries two independent sets — one per scope (conception /
 * user). Pre-reframe per-harness keys (`skillsGeneric`, `skillsClaude`,
 * `skillsKimi`, `skillsOpencode`) collapsed into the conception-scope `skills`
 * key when the tab dimension was dropped.
 */
export function createTreeExpansion(deps: TreeExpansionDeps): TreeExpansion {
  const [knowledgeExpanded, setKnowledgeExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [resourcesExpanded, setResourcesExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [skillsConceptionExpanded, setSkillsConceptionExpanded] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [skillsUserExpanded, setSkillsUserExpanded] = createSignal<ReadonlySet<string>>(new Set());

  void window.condash.getTreeExpansion().then((prefs) => {
    setKnowledgeExpanded(new Set(prefs.knowledge));
    setResourcesExpanded(new Set(prefs.resources));
    // Legacy `skills` key was the conception-scope set in earlier versions —
    // hydrate from it when present so users with prior expanded state don't
    // lose it on the reframe upgrade.
    setSkillsConceptionExpanded(new Set(prefs.skills));
    setSkillsUserExpanded(new Set(prefs.skillsUser));
  });

  const skillsGetter = (scope: SkillScope): Accessor<ReadonlySet<string>> =>
    scope === 'user' ? skillsUserExpanded : skillsConceptionExpanded;
  const skillsSetter = (scope: SkillScope) =>
    scope === 'user' ? setSkillsUserExpanded : setSkillsConceptionExpanded;

  /** Persist the union of every pane / scope set to settings.json.
   *  Fire-and-forget — a write failure surfaces as a toast but the
   *  in-memory state stays authoritative for the session. */
  const persistTreeExpansion = (): void => {
    const prefs = {
      knowledge: Array.from(knowledgeExpanded()),
      resources: Array.from(resourcesExpanded()),
      skills: Array.from(skillsConceptionExpanded()),
      skillsUser: Array.from(skillsUserExpanded()),
    };
    void window.condash.setTreeExpansion(prefs).catch((err) => {
      deps.flashToast(`Could not persist tree expansion: ${(err as Error).message}`, 'error');
    });
  };

  const resolveSkillsScope = (scope: SkillScope | undefined): SkillScope => scope ?? 'conception';

  const toggleTreeExpand = (treeKey: TreeRoot, relPath: string, skillScope?: SkillScope): void => {
    if (treeKey === 'knowledge') {
      const next = new Set(knowledgeExpanded());
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      setKnowledgeExpanded(next);
    } else if (treeKey === 'resources') {
      const next = new Set(resourcesExpanded());
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      setResourcesExpanded(next);
    } else {
      const scope = resolveSkillsScope(skillScope);
      const cur = skillsGetter(scope)();
      const next = new Set(cur);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      skillsSetter(scope)(next);
    }
    persistTreeExpansion();
  };

  const expandTreeDir = (treeKey: TreeRoot, relPath: string, skillScope?: SkillScope): void => {
    if (relPath === '') return; // root is always expanded; no need to track
    if (treeKey === 'knowledge') {
      const cur = knowledgeExpanded();
      if (cur.has(relPath)) return;
      const next = new Set(cur);
      next.add(relPath);
      setKnowledgeExpanded(next);
    } else if (treeKey === 'resources') {
      const cur = resourcesExpanded();
      if (cur.has(relPath)) return;
      const next = new Set(cur);
      next.add(relPath);
      setResourcesExpanded(next);
    } else {
      const scope = resolveSkillsScope(skillScope);
      const cur = skillsGetter(scope)();
      if (cur.has(relPath)) return;
      const next = new Set(cur);
      next.add(relPath);
      skillsSetter(scope)(next);
    }
    persistTreeExpansion();
  };

  return {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpandedForScope: skillsGetter,
    toggleTreeExpand,
    expandTreeDir,
  };
}
