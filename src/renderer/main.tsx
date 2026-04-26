import { render } from 'solid-js/web';
import { createResource, createSignal, For, onCleanup, onMount, Show, Suspense } from 'solid-js';
import type {
  Deliverable,
  KnowledgeNode,
  OpenWithSlotKey,
  OpenWithSlots,
  Project,
  RepoEntry,
  SearchHit,
  Step,
  StepCounts,
  StepMarker,
  TerminalPrefs,
  Theme,
  TreeEvent,
} from '@shared/types';
import { KNOWN_STATUSES, STEP_MARKERS } from '@shared/types';
import { NoteModal, type ModalState } from './note-modal';
import { ProjectPreview } from './project-preview';
import { resetMermaidTheme } from './markdown';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { buildSlugIndex } from './wikilinks';
import './styles.css';
import './note-modal.css';
import './project-preview.css';

type Tab = 'projects' | 'history' | 'knowledge' | 'search' | 'code';

const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<Theme, string> = {
  system: '◐ system',
  light: '☀ light',
  dark: '☾ dark',
};

const MARKER_GLYPH: Record<StepMarker, string> = {
  ' ': '☐',
  '~': '◐',
  x: '☑',
  '-': '✕',
};

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '-': 'dropped',
};

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
}

function hasSteps(c: StepCounts): boolean {
  return c.todo + c.doing + c.done + c.dropped > 0;
}

function StepBadge(props: { counts: StepCounts }) {
  const total = (): number =>
    props.counts.todo + props.counts.doing + props.counts.done + props.counts.dropped;
  const title = (): string =>
    `${props.counts.todo} todo, ${props.counts.doing} doing, ${props.counts.done} done, ${props.counts.dropped} dropped`;
  return (
    <span class="badge steps" title={title()}>
      <span class="step-done">{props.counts.done}</span>
      <span class="step-sep">/</span>
      <span class="step-total">{total()}</span>
    </span>
  );
}

function nextMarker(current: StepMarker): StepMarker {
  const idx = STEP_MARKERS.indexOf(current);
  return STEP_MARKERS[(idx + 1) % STEP_MARKERS.length];
}

function applyStepMarker(
  items: Project[],
  path: string,
  lineIndex: number,
  marker: StepMarker,
): Project[] {
  return items.map((p) => {
    if (p.path !== path) return p;
    const steps = p.steps.map((s) => (s.lineIndex === lineIndex ? { ...s, marker } : s));
    return { ...p, steps, stepCounts: countSteps(steps) };
  });
}

function countSteps(steps: readonly Step[]): StepCounts {
  const c: StepCounts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const s of steps) {
    if (s.marker === ' ') c.todo++;
    else if (s.marker === '~') c.doing++;
    else if (s.marker === 'x') c.done++;
    else if (s.marker === '-') c.dropped++;
  }
  return c;
}

function applyStatus(items: Project[], path: string, status: string): Project[] {
  return items.map((p) => (p.path === path ? { ...p, status } : p));
}

const DRAG_MIME = 'application/x-condash-project-path';

type Group = { status: string; items: Project[] };

const UNKNOWN = '?';

const ACTIVE_STATUSES = ['now', 'review'] as const;
const PIPELINE_STATUSES = ['soon', 'later', 'backlog'] as const;

type ProjectColumn = { name: string; statuses: readonly string[]; includeUnknown: boolean };

const PROJECT_COLUMNS: readonly ProjectColumn[] = [
  { name: 'Active', statuses: ACTIVE_STATUSES, includeUnknown: false },
  { name: 'Pipeline', statuses: PIPELINE_STATUSES, includeUnknown: true },
];

function groupByStatus(items: Project[]): Map<string, Project[]> {
  const buckets = new Map<string, Project[]>();
  for (const status of KNOWN_STATUSES) buckets.set(status, []);
  buckets.set(UNKNOWN, []);

  for (const item of items) {
    const key = (KNOWN_STATUSES as readonly string[]).includes(item.status) ? item.status : UNKNOWN;
    buckets.get(key)!.push(item);
  }
  return buckets;
}

function columnGroups(buckets: Map<string, Project[]>, column: ProjectColumn): Group[] {
  const out: Group[] = [];
  for (const status of column.statuses) {
    out.push({ status, items: buckets.get(status) ?? [] });
  }
  if (column.includeUnknown) {
    const unknown = buckets.get(UNKNOWN) ?? [];
    if (unknown.length > 0) out.push({ status: UNKNOWN, items: unknown });
  }
  return out;
}

function monthFromPath(path: string): string {
  // projects/YYYY-MM/YYYY-MM-DD-slug/ → "YYYY-MM"
  const parts = path.split('/');
  const idx = parts.indexOf('projects');
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return '????-??';
}

type MonthGroup = { month: string; items: Project[] };

function groupDoneByMonth(items: Project[]): MonthGroup[] {
  const map = new Map<string, Project[]>();
  for (const p of items) {
    if (p.status !== 'done') continue;
    const key = monthFromPath(p.path);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(p);
  }
  const months = Array.from(map.keys()).sort((a, b) => b.localeCompare(a));
  return months.map((month) => ({
    month,
    items: (map.get(month) ?? []).slice().sort((a, b) => b.slug.localeCompare(a.slug)),
  }));
}

interface Shortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

function parseShortcut(spec: string | undefined): Shortcut | null {
  if (!spec) return null;
  const parts = spec
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: Shortcut = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') out.ctrl = true;
    else if (lower === 'shift') out.shift = true;
    else if (lower === 'alt' || lower === 'option') out.alt = true;
    else if (lower === 'cmd' || lower === 'meta' || lower === 'super') out.meta = true;
    else out.key = part.length === 1 ? part.toLowerCase() : part;
  }
  return out.key ? out : null;
}

function matchesShortcut(event: KeyboardEvent, shortcut: Shortcut | null): boolean {
  if (!shortcut) return false;
  if (shortcut.ctrl !== event.ctrlKey) return false;
  if (shortcut.shift !== event.shiftKey) return false;
  if (shortcut.alt !== event.altKey) return false;
  if (shortcut.meta !== event.metaKey) return false;
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return eventKey === shortcut.key;
}

function App() {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);
  const [theme, setTheme] = createSignal<Theme>('system');
  const [toast, setToast] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>('projects');
  const [modal, setModal] = createSignal<ModalState>(null);
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [terminalOpen, setTerminalOpen] = createSignal(false);
  let terminalHandle: TerminalPaneHandle | null = null;
  const [searchQuery, setSearchQuery] = createSignal('');
  const [searchInput, setSearchInput] = createSignal('');
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  void window.condash.getConceptionPath().then(setConceptionPath);
  void window.condash.getTheme().then((t) => {
    setTheme(t);
    applyTheme(t);
  });

  const unsubscribe = window.condash.onTreeEvents((events) => {
    void handleTreeEvents(events);
  });
  onCleanup(unsubscribe);

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme());
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    setTheme(next);
    applyTheme(next);
    resetMermaidTheme();
    void window.condash.setTheme(next);
  };

  const [projects, { mutate }] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return [] as Project[];
      return window.condash.listProjects();
    },
  );

  const [knowledge] = createResource(
    () => [conceptionPath(), refreshKey(), tab()] as const,
    async ([path, , currentTab]) => {
      if (!path || (currentTab !== 'knowledge' && currentTab !== 'search')) return null;
      return window.condash.readKnowledgeTree();
    },
  );

  const [searchResults] = createResource(
    () => [conceptionPath(), tab(), searchQuery()] as const,
    async ([path, currentTab, query]) => {
      if (!path || currentTab !== 'search' || query.trim().length === 0) {
        return [] as SearchHit[];
      }
      return window.condash.search(query);
    },
  );

  const [repos] = createResource(
    () => [conceptionPath(), refreshKey(), tab()] as const,
    async ([path, , currentTab]) => {
      if (!path || currentTab !== 'code') return [] as RepoEntry[];
      return window.condash.listRepos();
    },
  );

  const [openWithSlots] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return {} as OpenWithSlots;
      return window.condash.listOpenWith();
    },
  );

  const [terminalPrefs] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return {} as TerminalPrefs;
      return window.condash.termGetPrefs();
    },
  );

  const handleLaunch = async (slot: OpenWithSlotKey, path: string) => {
    try {
      await window.condash.launchOpenWith(slot, path);
    } catch (err) {
      flashToast(`Launch failed: ${(err as Error).message}`);
    }
  };

  const handleForceStop = async (repo: RepoEntry) => {
    if (!window.confirm(`Force-stop ${repo.name}?`)) return;
    try {
      await window.condash.forceStopRepo(repo.name);
      flashToast(`Force-stopped ${repo.name}`);
    } catch (err) {
      flashToast(`Force-stop failed: ${(err as Error).message}`);
    }
  };

  const ensureTerminalOpen = (): void => {
    if (!terminalOpen()) setTerminalOpen(true);
  };

  const handleGlobalKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    // Don't grab keystrokes from text inputs / editor / inside the xterm host —
    // the xterm canvas swallows printable keys via its own listener already.
    if (target?.closest('.xterm-host, input, textarea, .cm-editor, [contenteditable=true]')) {
      // The pane-toggle shortcut is the one exception: the user expects it
      // to work from inside the active terminal too.
    }

    const prefs = terminalPrefs() ?? {};
    const toggle = parseShortcut(prefs.shortcut ?? 'Ctrl+`');
    if (matchesShortcut(event, toggle)) {
      event.preventDefault();
      setTerminalOpen((v) => !v);
      return;
    }

    // Move-tab shortcuts only fire when the pane is open.
    if (!terminalOpen() || !terminalHandle) return;
    const left = parseShortcut(prefs.move_tab_left_shortcut ?? 'Ctrl+Left');
    const right = parseShortcut(prefs.move_tab_right_shortcut ?? 'Ctrl+Right');
    if (matchesShortcut(event, left)) {
      event.preventDefault();
      terminalHandle.moveActiveTab(-1);
      return;
    }
    if (matchesShortcut(event, right)) {
      event.preventDefault();
      terminalHandle.moveActiveTab(1);
      return;
    }
    const paste = parseShortcut(prefs.screenshot_paste_shortcut);
    if (matchesShortcut(event, paste)) {
      event.preventDefault();
      void handleScreenshotPaste();
    }
  };

  const handleScreenshotPaste = async (): Promise<void> => {
    const prefs = terminalPrefs() ?? {};
    const dir = prefs.screenshot_dir;
    if (!dir) {
      flashToast('No terminal.screenshot_dir set in configuration.json');
      return;
    }
    const latest = await window.condash.termLatestScreenshot(dir);
    if (!latest) {
      flashToast(`No files under ${dir}`);
      return;
    }
    if (!terminalHandle) return;
    terminalHandle.typeIntoActive(latest);
  };

  onMount(() => {
    document.addEventListener('keydown', handleGlobalKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleGlobalKeyDown);
  });

  const handleRunRepo = async (repo: RepoEntry) => {
    if (!terminalHandle) {
      ensureTerminalOpen();
      // Wait one tick so the pane mounts and registers its handle.
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }
    if (!terminalHandle) return;
    ensureTerminalOpen();
    try {
      await terminalHandle.spawn({ side: 'code', repo: repo.name }, repo.name);
    } catch (err) {
      flashToast(`Run failed: ${(err as Error).message}`);
    }
  };

  const onSearchInput = (value: string): void => {
    setSearchInput(value);
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => setSearchQuery(value), 200);
  };

  onCleanup(() => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  });

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 4000);
  };

  const handlePick = async () => {
    const picked = await window.condash.pickConceptionPath();
    if (picked) {
      setConceptionPath(picked);
      setRefreshKey((k) => k + 1);
    }
  };

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  const handleTreeEvents = async (events: TreeEvent[]): Promise<void> => {
    let knowledgeOrConfigDirty = false;
    let unknownSeen = false;

    for (const event of events) {
      if (event.kind === 'unknown') {
        unknownSeen = true;
        break;
      }
      if (event.kind === 'config' || event.kind === 'knowledge') {
        knowledgeOrConfigDirty = true;
        continue;
      }
      // Per-project patch.
      try {
        if (event.op === 'unlink') {
          mutate((items) => (items ?? []).filter((p) => p.path !== event.path));
          continue;
        }
        const project = await window.condash.getProject(event.path);
        if (!project) {
          mutate((items) => (items ?? []).filter((p) => p.path !== event.path));
          continue;
        }
        mutate((items) => {
          const list = items ?? [];
          const idx = list.findIndex((p) => p.path === project.path);
          if (idx === -1) return [...list, project];
          const next = list.slice();
          next[idx] = project;
          return next;
        });
      } catch {
        unknownSeen = true;
      }
    }

    if (unknownSeen || knowledgeOrConfigDirty) {
      setRefreshKey((k) => k + 1);
    }
  };

  const handleOpenInEditor = (path: string) => {
    void window.condash.openInEditor(path);
  };

  const handleOpenDeliverable = (path: string) => {
    if (path.toLowerCase().endsWith('.pdf')) {
      setPdfPath(path);
    } else {
      void window.condash.openInEditor(path);
    }
  };

  const handleOpenProject = (project: Project) => {
    setPreviewPath(project.path);
  };

  const previewProject = (): Project | null => {
    const path = previewPath();
    if (!path) return null;
    return (projects() ?? []).find((p) => p.path === path) ?? null;
  };

  const handleOpenReadmeFromPreview = (project: Project) => {
    setPreviewPath(null);
    setModal({
      path: project.path,
      title: project.title,
      deliverables: project.deliverables,
    });
  };

  const handleOpenDeliverableFromPreview = (deliverable: Deliverable) => {
    if (deliverable.path.toLowerCase().endsWith('.pdf')) {
      setPdfPath(deliverable.path);
    } else {
      void window.condash.openInEditor(deliverable.path);
    }
  };

  const handleOpenKnowledgeFile = (path: string) => {
    setModal({ path });
  };

  const handleOpenPreferences = () => {
    const cp = conceptionPath();
    if (!cp) return;
    setModal({
      path: `${cp}/configuration.json`,
      title: 'Preferences (configuration.json)',
      initialMode: 'edit',
    });
  };

  const slugIndex = () => buildSlugIndex(projects() ?? [], knowledge() ?? null);

  const handleWikilink = (slug: string) => {
    const matches = slugIndex().get(slug);
    if (!matches || matches.length === 0) {
      flashToast(`No item matches [[${slug}]]`);
      return;
    }
    const target = matches[0];
    setModal({ path: target.path, title: target.title });
    if (matches.length > 1) {
      flashToast(`[[${slug}]] matched ${matches.length} items — opening the first`);
    }
  };

  const handleToggleStep = async (project: Project, step: Step) => {
    const next = nextMarker(step.marker);
    mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, next));
    try {
      await window.condash.toggleStep(project.path, step.lineIndex, step.marker, next);
    } catch (err) {
      mutate((items) => applyStepMarker(items ?? [], project.path, step.lineIndex, step.marker));
      flashToast(`Toggle failed: ${(err as Error).message}`);
    }
  };

  const handleDropOnColumn = async (path: string, newStatus: string) => {
    const items = projects() ?? [];
    const project = items.find((p) => p.path === path);
    if (!project) return;
    if (project.status === newStatus) return;

    const previous = project.status;
    mutate((current) => applyStatus(current ?? [], path, newStatus));
    try {
      await window.condash.setStatus(path, newStatus);
    } catch (err) {
      mutate((current) => applyStatus(current ?? [], path, previous));
      flashToast(`Status change failed: ${(err as Error).message}`);
    }
  };

  return (
    <div class="app">
      <header class="toolbar">
        <h1>condash</h1>
        <nav class="tabs">
          <button
            class="tab"
            classList={{ active: tab() === 'projects' }}
            onClick={() => setTab('projects')}
          >
            Projects
          </button>
          <button
            class="tab"
            classList={{ active: tab() === 'history' }}
            onClick={() => setTab('history')}
            disabled={!conceptionPath()}
          >
            History
          </button>
          <button
            class="tab"
            classList={{ active: tab() === 'knowledge' }}
            onClick={() => setTab('knowledge')}
            disabled={!conceptionPath()}
          >
            Knowledge
          </button>
          <button
            class="tab"
            classList={{ active: tab() === 'search' }}
            onClick={() => setTab('search')}
            disabled={!conceptionPath()}
          >
            Search
          </button>
          <button
            class="tab"
            classList={{ active: tab() === 'code' }}
            onClick={() => setTab('code')}
            disabled={!conceptionPath()}
          >
            Code
          </button>
        </nav>
        <span class="path">{conceptionPath() ?? '(no conception path)'}</span>
        <button onClick={cycleTheme} title="Cycle theme">
          {THEME_LABEL[theme()]}
        </button>
        <button
          onClick={() => setTerminalOpen((v) => !v)}
          classList={{ active: terminalOpen() }}
          title="Toggle terminal pane (Ctrl+`)"
        >
          ▤
        </button>
        <button
          onClick={handleOpenPreferences}
          disabled={!conceptionPath()}
          title="Edit configuration.json"
        >
          ⚙
        </button>
        <button onClick={handleRefresh} disabled={!conceptionPath()}>
          Refresh
        </button>
        <button onClick={handlePick}>{conceptionPath() ? 'Change…' : 'Choose folder…'}</button>
      </header>

      <Show
        when={conceptionPath()}
        fallback={
          <div class="empty">
            <p>Pick a conception directory to list its projects.</p>
            <button onClick={handlePick}>Choose folder…</button>
          </div>
        }
      >
        <Show when={tab() === 'projects'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(projects() ?? []).length > 0}
              fallback={<div class="empty">No projects found under projects/.</div>}
            >
              <ProjectsView
                buckets={groupByStatus(projects() ?? [])}
                onOpen={handleOpenProject}
                onToggleStep={handleToggleStep}
                onDropProject={handleDropOnColumn}
              />
            </Show>
          </Suspense>
        </Show>

        <Show when={tab() === 'history'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <HistoryView
              months={groupDoneByMonth(projects() ?? [])}
              onOpen={handleOpenProject}
              onToggleStep={handleToggleStep}
            />
          </Suspense>
        </Show>

        <Show when={tab() === 'knowledge'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={knowledge()}
              fallback={
                <div class="empty">No knowledge/ directory under the selected conception path.</div>
              }
            >
              <div class="knowledge-pane">
                <KnowledgeTree node={knowledge()!} onOpen={handleOpenKnowledgeFile} />
              </div>
            </Show>
          </Suspense>
        </Show>

        <Show when={tab() === 'code'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={(repos() ?? []).length > 0}
              fallback={
                <div class="empty">
                  No repositories listed. Add <code>repositories.primary</code> /{' '}
                  <code>secondary</code> to <code>configuration.json</code> via the gear.
                </div>
              }
            >
              <div class="repos-pane">
                <For each={repos() ?? []}>
                  {(repo) => (
                    <RepoRow
                      repo={repo}
                      slots={openWithSlots() ?? {}}
                      onOpen={handleOpenInEditor}
                      onLaunch={(slot, path) => void handleLaunch(slot, path)}
                      onForceStop={(r) => void handleForceStop(r)}
                      onRun={(r) => void handleRunRepo(r)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Suspense>
        </Show>

        <Show when={tab() === 'search'}>
          <div class="search-pane">
            <input
              class="search-input"
              type="search"
              placeholder="Search projects + knowledge…"
              value={searchInput()}
              onInput={(e) => onSearchInput(e.currentTarget.value)}
            />
            <Show when={searchInput().trim().length > 0}>
              <Suspense fallback={<div class="empty">Searching…</div>}>
                <Show
                  when={(searchResults() ?? []).length > 0}
                  fallback={<div class="empty">No matches.</div>}
                >
                  <ul class="search-results">
                    <For each={searchResults() ?? []}>
                      {(hit) => <SearchResult hit={hit} onOpen={handleOpenKnowledgeFile} />}
                    </For>
                  </ul>
                </Show>
              </Suspense>
            </Show>
          </div>
        </Show>
      </Show>

      <ProjectPreview
        project={previewProject()}
        onClose={() => setPreviewPath(null)}
        onToggleStep={handleToggleStep}
        onChangeStatus={(p, s) => void handleDropOnColumn(p.path, s)}
        onOpenReadme={handleOpenReadmeFromPreview}
        onOpenInEditor={handleOpenInEditor}
        onOpenDeliverable={handleOpenDeliverableFromPreview}
      />

      <Show when={modal()}>
        <NoteModal
          state={modal()}
          onClose={() => setModal(null)}
          onOpenInEditor={handleOpenInEditor}
          onOpenDeliverable={handleOpenDeliverable}
          onWikilink={handleWikilink}
        />
      </Show>

      <Show when={pdfPath()}>
        <PdfModal
          path={pdfPath()!}
          onClose={() => setPdfPath(null)}
          onOpenInOs={handleOpenInEditor}
        />
      </Show>

      <TerminalPane
        open={terminalOpen()}
        onClose={() => setTerminalOpen(false)}
        launcherCommand={terminalPrefs()?.launcher_command ?? null}
        registerHandle={(handle) => {
          terminalHandle = handle;
        }}
      />

      <Show when={toast()}>
        <div class="toast" role="status">
          {toast()}
        </div>
      </Show>
    </div>
  );
}

function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  return (
    <div class="projects-columns">
      <For each={PROJECT_COLUMNS}>
        {(col) => (
          <ProjectsColumn
            name={col.name}
            groups={columnGroups(props.buckets, col)}
            onOpen={props.onOpen}
            onToggleStep={props.onToggleStep}
            onDropProject={props.onDropProject}
          />
        )}
      </For>
    </div>
  );
}

function ProjectsColumn(props: {
  name: string;
  groups: Group[];
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const totalCount = (): number => props.groups.reduce((acc, g) => acc + g.items.length, 0);
  return (
    <section class="projects-column">
      <header class="projects-column-header">
        <span class="name">{props.name}</span>
        <span class="count">{totalCount()}</span>
      </header>
      <div class="projects-column-body">
        <For each={props.groups}>
          {(group) => (
            <GroupBlock
              group={group}
              onOpen={props.onOpen}
              onToggleStep={props.onToggleStep}
              onDropProject={props.onDropProject}
            />
          )}
        </For>
      </div>
    </section>
  );
}

function GroupBlock(props: {
  group: Group;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const [over, setOver] = createSignal(false);

  const isAcceptable = (event: DragEvent): boolean => {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes(DRAG_MIME) : false;
  };

  const handleDragEnter = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(true);
  };

  const handleDragOver = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(false);
    const path = e.dataTransfer?.getData(DRAG_MIME);
    if (path) props.onDropProject(path, props.group.status);
  };

  return (
    <section
      class="group-block"
      classList={{ 'drag-over': over() }}
      data-status={props.group.status}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header class="group-header">
        <span class="name">{props.group.status}</span>
        <span class="count">{props.group.items.length}</span>
      </header>
      <div class="group-body">
        <For each={props.group.items}>
          {(item) => <Card item={item} onOpen={props.onOpen} onToggleStep={props.onToggleStep} />}
        </For>
      </div>
    </section>
  );
}

function HistoryView(props: {
  months: MonthGroup[];
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
}) {
  return (
    <div class="history-pane">
      <Show when={props.months.length > 0} fallback={<div class="empty">No done items yet.</div>}>
        <For each={props.months}>
          {(group) => (
            <section class="history-month">
              <header class="history-month-header">
                <span class="name">{group.month}</span>
                <span class="count">{group.items.length}</span>
              </header>
              <div class="history-month-body">
                <For each={group.items}>
                  {(item) => (
                    <Card
                      item={item}
                      onOpen={props.onOpen}
                      onToggleStep={props.onToggleStep}
                      draggable={false}
                    />
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </Show>
    </div>
  );
}

function Card(props: {
  item: Project;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  draggable?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const handleHeaderClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.step-toggle, .expander')) return;
    props.onOpen(props.item);
  };

  const handleDragStart = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_MIME, props.item.path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const isDraggable = (): boolean => props.draggable !== false;

  return (
    <article
      class="row"
      title={props.item.path}
      draggable={isDraggable()}
      onDragStart={isDraggable() ? handleDragStart : undefined}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        <span class="title">{props.item.title}</span>
        <Show when={props.item.summary}>
          <p class="summary">{props.item.summary}</p>
        </Show>
        <div class="meta">
          <span class="slug">{props.item.slug}</span>
          <Show when={props.item.kind !== 'unknown'}>
            <span class="badge">{props.item.kind}</span>
          </Show>
          <Show when={props.item.apps}>
            <span class="badge">{props.item.apps}</span>
          </Show>
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="badge steps expander"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={`${props.item.steps.length} steps · click to ${expanded() ? 'collapse' : 'expand'}`}
            >
              <StepBadge counts={props.item.stepCounts} />
              <span class="expander-arrow">{expanded() ? '▾' : '▸'}</span>
            </button>
          </Show>
          <Show when={props.item.deliverableCount > 0}>
            <span class="badge" title="deliverables">
              ⬇ {props.item.deliverableCount}
            </span>
          </Show>
          <Show when={!(KNOWN_STATUSES as readonly string[]).includes(props.item.status)}>
            <span class="badge warn">!? {props.item.status}</span>
          </Show>
        </div>
      </div>
      <Show when={expanded() && props.item.steps.length > 0}>
        <ul class="steps-list">
          <For each={props.item.steps}>
            {(step) => (
              <li class={`step step-marker-${markerClass(step.marker)}`}>
                <button
                  class="step-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleStep(props.item, step);
                  }}
                  title={`${MARKER_LABEL[step.marker]} → ${MARKER_LABEL[nextMarker(step.marker)]}`}
                >
                  {MARKER_GLYPH[step.marker]}
                </button>
                <span class="step-text">{step.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </article>
  );
}

function KnowledgeTree(props: { node: KnowledgeNode; onOpen: (path: string) => void }) {
  return (
    <ul class="knowledge-tree knowledge-tree-root">
      <KnowledgeNodeView node={props.node} depth={0} onOpen={props.onOpen} initiallyExpanded />
    </ul>
  );
}

function KnowledgeNodeView(props: {
  node: KnowledgeNode;
  depth: number;
  onOpen: (path: string) => void;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(props.initiallyExpanded ?? props.depth === 0);

  return (
    <li class="knowledge-node" data-kind={props.node.kind}>
      <Show
        when={props.node.kind === 'directory'}
        fallback={
          <button
            class="knowledge-leaf"
            onClick={() => props.onOpen(props.node.path)}
            title={props.node.path}
          >
            <span class="knowledge-icon">📄</span>
            <span class="knowledge-title">{props.node.title}</span>
          </button>
        }
      >
        <button class="knowledge-dir" onClick={() => setExpanded((v) => !v)}>
          <span class="knowledge-icon">{expanded() ? '▾' : '▸'}</span>
          <span class="knowledge-title">{props.node.title}</span>
          <Show when={props.node.children}>
            <span class="knowledge-count">{props.node.children!.length}</span>
          </Show>
        </button>
        <Show when={expanded() && props.node.children}>
          <ul class="knowledge-tree">
            <For each={props.node.children}>
              {(child) => (
                <KnowledgeNodeView node={child} depth={props.depth + 1} onOpen={props.onOpen} />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </li>
  );
}

function RepoRow(props: {
  repo: RepoEntry;
  slots: OpenWithSlots;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry) => void;
}) {
  const dirtyLabel = (): string => {
    if (props.repo.missing) return 'missing';
    if (props.repo.dirty == null) return '?';
    if (props.repo.dirty === 0) return 'clean';
    return `${props.repo.dirty} dirty`;
  };

  return (
    <article
      class="repo-row"
      classList={{ missing: props.repo.missing, dirty: !!props.repo.dirty }}
    >
      <div class="repo-head">
        <span class="repo-name">{props.repo.name}</span>
        <span class="badge" data-kind={props.repo.kind}>
          {props.repo.kind}
        </span>
        <span class="repo-dirty">{dirtyLabel()}</span>
      </div>
      <span class="repo-path">{props.repo.path}</span>
      <div class="repo-actions">
        <button
          class="modal-button"
          onClick={() => props.onOpen(props.repo.path)}
          disabled={props.repo.missing}
          title="Open in OS file manager"
        >
          Open
        </button>
        <button
          class="modal-button"
          onClick={() => props.onRun(props.repo)}
          disabled={props.repo.missing}
          title="Run in terminal pane"
        >
          ▶ Run
        </button>
        <For each={LAUNCHER_SLOTS}>
          {(slot) => (
            <Show when={props.slots[slot]}>
              <button
                class="modal-button"
                onClick={() => props.onLaunch(slot, props.repo.path)}
                disabled={props.repo.missing}
                title={props.slots[slot]!.label}
              >
                {LAUNCHER_GLYPH[slot]}
              </button>
            </Show>
          )}
        </For>
        <Show when={props.repo.hasForceStop}>
          <button
            class="modal-button warn"
            onClick={() => props.onForceStop(props.repo)}
            disabled={props.repo.missing}
            title="Force-stop (runs configured force_stop:)"
          >
            ⏹
          </button>
        </Show>
      </div>
      <Show when={props.repo.worktrees && props.repo.worktrees.length > 1}>
        <ul class="worktrees">
          <For each={props.repo.worktrees!.filter((w) => !w.primary)}>
            {(wt) => (
              <li class="worktree-row">
                <span class="worktree-branch">{wt.branch ?? '(detached)'}</span>
                <span class="worktree-path">{wt.path}</span>
                <div class="worktree-actions">
                  <button
                    class="modal-button"
                    onClick={() => props.onOpen(wt.path)}
                    title="Open worktree in OS file manager"
                  >
                    Open
                  </button>
                  <For each={LAUNCHER_SLOTS}>
                    {(slot) => (
                      <Show when={props.slots[slot]}>
                        <button
                          class="modal-button"
                          onClick={() => props.onLaunch(slot, wt.path)}
                          title={props.slots[slot]!.label}
                        >
                          {LAUNCHER_GLYPH[slot]}
                        </button>
                      </Show>
                    )}
                  </For>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </article>
  );
}

const LAUNCHER_SLOTS: readonly OpenWithSlotKey[] = ['main_ide', 'secondary_ide', 'terminal'];
const LAUNCHER_GLYPH: Record<OpenWithSlotKey, string> = {
  main_ide: '⌘',
  secondary_ide: '⌥',
  terminal: '▶',
};

function SearchResult(props: { hit: SearchHit; onOpen: (path: string) => void }) {
  return (
    <li class="search-result">
      <button class="search-row" onClick={() => props.onOpen(props.hit.path)}>
        <div class="search-head">
          <span class="search-title">{props.hit.title}</span>
          <span class="badge">{props.hit.source}</span>
          <span class="search-count">{props.hit.matchCount}</span>
        </div>
        <span class="search-path">{props.hit.path}</span>
        <ul class="search-snippets">
          <For each={props.hit.snippets}>{(s) => <li>{s}</li>}</For>
        </ul>
      </button>
    </li>
  );
}

function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  return 'dropped';
}

function PdfModal(props: {
  path: string;
  onClose: () => void;
  onOpenInOs: (path: string) => void;
}) {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKey, true);
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKey, true);
  });

  const fileUrl = (): string => {
    const encoded = props.path
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `file://${encoded}`;
  };

  const fileName = (): string => props.path.split('/').pop() ?? props.path;

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal pdf-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">{fileName()}</span>
          <span class="modal-path">{props.path}</span>
          <button
            class="modal-button"
            onClick={() => props.onOpenInOs(props.path)}
            title="Open in OS default viewer"
          >
            ↗
          </button>
          <button class="modal-button" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </header>
        <div class="pdf-body">
          <webview src={fileUrl()} partition="persist:pdf" class="pdf-webview" />
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
