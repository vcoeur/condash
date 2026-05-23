import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { SkillTab, TreeRoot } from '@shared/types';

export interface TreeExpansionDeps {
  /** Surface a transient toast in the renderer (used for persist failures). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface TreeExpansion {
  knowledgeExpanded: Accessor<ReadonlySet<string>>;
  resourcesExpanded: Accessor<ReadonlySet<string>>;
  /** Per-tab expanded set for the Skills pane. Pass `'claude'` to get the
   *  set previously keyed on `skills`; the legacy key was migrated by the
   *  main-process IPC handler on first read. */
  skillsExpandedByTab: (tab: SkillTab) => Accessor<ReadonlySet<string>>;
  /** Toggle a directory's expanded state in the given pane and persist.
   *  When `treeKey === 'skills'`, `skillTab` is required. */
  toggleTreeExpand: (treeKey: TreeRoot, relPath: string, skillTab?: SkillTab) => void;
  /** Force a directory into the expanded set without toggling — used after
   *  a successful tree mutation so the user can see the new file. */
  expandTreeDir: (treeKey: TreeRoot, relPath: string, skillTab?: SkillTab) => void;
}

/**
 * Per-pane expansion state for the Knowledge / Resources / Skills tree
 * panes (issue #89). Each set holds the directory `relPath`s that are
 * currently expanded; an empty set means the pane is fully collapsed
 * (the on-purpose first-load state). The hydrate-from-IPC then-callback
 * overrides the empty defaults when the user has prior state on disk.
 *
 * The Skills pane carries three independent sets — one per agent tab
 * (Generic / Claude / Kimi). The on-disk schema migrates the legacy
 * `skills` key into `skillsClaude` on first read.
 */
export function createTreeExpansion(deps: TreeExpansionDeps): TreeExpansion {
  const [knowledgeExpanded, setKnowledgeExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [resourcesExpanded, setResourcesExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [skillsGenericExpanded, setSkillsGenericExpanded] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [skillsClaudeExpanded, setSkillsClaudeExpanded] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const [skillsKimiExpanded, setSkillsKimiExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [skillsOpencodeExpanded, setSkillsOpencodeExpanded] = createSignal<ReadonlySet<string>>(
    new Set(),
  );

  void window.condash.getTreeExpansion().then((prefs) => {
    setKnowledgeExpanded(new Set(prefs.knowledge));
    setResourcesExpanded(new Set(prefs.resources));
    setSkillsGenericExpanded(new Set(prefs.skillsGeneric));
    setSkillsClaudeExpanded(new Set(prefs.skillsClaude));
    setSkillsKimiExpanded(new Set(prefs.skillsKimi));
    setSkillsOpencodeExpanded(new Set(prefs.skillsOpencode));
  });

  const skillsGetter = (tab: SkillTab): Accessor<ReadonlySet<string>> =>
    tab === 'generic'
      ? skillsGenericExpanded
      : tab === 'kimi'
        ? skillsKimiExpanded
        : tab === 'opencode'
          ? skillsOpencodeExpanded
          : skillsClaudeExpanded;
  const skillsSetter = (tab: SkillTab) =>
    tab === 'generic'
      ? setSkillsGenericExpanded
      : tab === 'kimi'
        ? setSkillsKimiExpanded
        : tab === 'opencode'
          ? setSkillsOpencodeExpanded
          : setSkillsClaudeExpanded;

  /** Persist the union of every pane / tab set to settings.json.
   *  Fire-and-forget — a write failure surfaces as a toast but the
   *  in-memory state stays authoritative for the session. */
  const persistTreeExpansion = (): void => {
    const prefs = {
      knowledge: Array.from(knowledgeExpanded()),
      resources: Array.from(resourcesExpanded()),
      skillsGeneric: Array.from(skillsGenericExpanded()),
      skillsClaude: Array.from(skillsClaudeExpanded()),
      skillsKimi: Array.from(skillsKimiExpanded()),
      skillsOpencode: Array.from(skillsOpencodeExpanded()),
    };
    void window.condash.setTreeExpansion(prefs).catch((err) => {
      deps.flashToast(`Could not persist tree expansion: ${(err as Error).message}`, 'error');
    });
  };

  const resolveSkillsTab = (skillTab: SkillTab | undefined): SkillTab => skillTab ?? 'claude';

  const toggleTreeExpand = (treeKey: TreeRoot, relPath: string, skillTab?: SkillTab): void => {
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
      const tab = resolveSkillsTab(skillTab);
      const cur = skillsGetter(tab)();
      const next = new Set(cur);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      skillsSetter(tab)(next);
    }
    persistTreeExpansion();
  };

  const expandTreeDir = (treeKey: TreeRoot, relPath: string, skillTab?: SkillTab): void => {
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
      const tab = resolveSkillsTab(skillTab);
      const cur = skillsGetter(tab)();
      if (cur.has(relPath)) return;
      const next = new Set(cur);
      next.add(relPath);
      skillsSetter(tab)(next);
    }
    persistTreeExpansion();
  };

  return {
    knowledgeExpanded,
    resourcesExpanded,
    skillsExpandedByTab: skillsGetter,
    toggleTreeExpand,
    expandTreeDir,
  };
}
