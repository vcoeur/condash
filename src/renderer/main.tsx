import { render } from 'solid-js/web';
import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js';
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
  TermSession,
  TerminalPrefs,
  Theme,
  TreeEvent,
  Worktree,
} from '@shared/types';
import { KNOWN_STATUSES, STEP_MARKERS } from '@shared/types';
import { CodeRunRows } from './code-runs';
import { NoteModal, type ModalState } from './note-modal';
import { ProjectPreview } from './project-preview';
import { resetMermaidTheme } from './markdown';
import { TerminalPane, type TerminalPaneHandle } from './terminal-pane';
import { buildSlugIndex } from './wikilinks';
import './styles.css';
import './note-modal.css';
import './project-preview.css';

type Tab = 'projects' | 'knowledge' | 'search' | 'code';

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

/** First step whose marker is not 'x' (done). Returns undefined if every step
 * is done — the card body collapses in that case. */
function nextOpenStep(item: Project): Step | undefined {
  return item.steps.find((s) => s.marker !== 'x');
}

function StepProgress(props: { counts: StepCounts }) {
  const total = (): number =>
    props.counts.todo + props.counts.doing + props.counts.done + props.counts.dropped;
  const ratio = (): number => {
    const t = total();
    return t === 0 ? 0 : Math.min(1, props.counts.done / t);
  };
  const title = (): string =>
    `${props.counts.todo} todo, ${props.counts.doing} doing, ${props.counts.done} done, ${props.counts.dropped} dropped`;
  return (
    <span class="step-progress-inner" title={title()}>
      <span class="progress-track">
        <span class="progress-fill" style={{ width: `${ratio() * 100}%` }} />
      </span>
      <span class="progress-text">
        {props.counts.done}/{total()}
      </span>
    </span>
  );
}

const KIND_ICON: Record<string, () => any> = {
  project: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5L14.5 8 8 14.5 1.5 8z" />
    </svg>
  ),
  incident: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2L14.5 13.5h-13z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  document: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.5h6L13 5v9.5H3.5z" />
      <path d="M9.5 1.5V5H13" />
      <path d="M5.5 8h5M5.5 10.5h5M5.5 5.5h2" />
    </svg>
  ),
};

function KindIcon(props: { kind: string }) {
  const Icon = KIND_ICON[props.kind];
  if (!Icon) return null;
  return <Icon />;
}

function AppsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5l6-3 6 3-6 3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11.5l6 3 6-3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v8" />
      <path d="M4.5 7L8 10.5 11.5 7" />
      <path d="M2.5 13.5h11" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.4" fill="currentColor" stroke="none" />
    </svg>
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

/** Order of stacked sections on the Projects tab. `backlog` and `done`
 * render collapsed-by-default — heavy buckets the user usually skips past. */
const PROJECT_SECTION_ORDER = ['now', 'review', 'soon', 'later', 'backlog', 'done'] as const;
const COLLAPSED_BY_DEFAULT = new Set<string>(['backlog', 'done']);

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

function projectsTabGroups(buckets: Map<string, Project[]>): Group[] {
  const out: Group[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    out.push({ status, items: buckets.get(status) ?? [] });
  }
  const unknown = buckets.get(UNKNOWN) ?? [];
  if (unknown.length > 0) out.push({ status: UNKNOWN, items: unknown });
  return out;
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

  // Track every live-or-exited session — Code tab uses code-side ones for
  // its inline runner rows, and the LIVE badge on repo cards is derived
  // from the same snapshot.
  const [allSessions, setAllSessions] = createSignal<readonly TermSession[]>([]);
  const liveRepos = createMemo<ReadonlySet<string>>(() => {
    const live = new Set<string>();
    for (const s of allSessions()) {
      if (s.repo && s.exited === undefined) live.add(s.repo);
    }
    return live;
  });
  const codeRunSessions = createMemo<readonly TermSession[]>(() =>
    allSessions().filter((s) => s.side === 'code'),
  );
  const offTermSessions = window.condash.onTermSessions((sessions) => {
    setAllSessions(sessions);
  });
  // Seed once on mount — onTermSessions only fires on changes, so without
  // this initial pull, sessions inherited from a prior renderer would not
  // surface until the next spawn/exit.
  void window.condash.termList().then(setAllSessions);
  onCleanup(offTermSessions);

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

  const repoGroups = createMemo(() => groupRepos(repos() ?? []));

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
    // Opening a fresh preview from a card resets any pending back-link from
    // a previously-opened file modal — the user has explicitly chosen a new
    // starting point.
    setPreviewBackPath(null);
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

  const handleEditStepText = async (project: Project, step: Step, newText: string) => {
    try {
      await window.condash.editStepText(project.path, step.lineIndex, step.text, newText);
      // Watcher fires a 'change' event for the README; the renderer patches in
      // place. No optimistic update — the line index could shift if anything
      // else changed in the file between read and write.
    } catch (err) {
      flashToast(`Edit step failed: ${(err as Error).message}`);
    }
  };

  const handleAddStep = async (project: Project, text: string) => {
    try {
      await window.condash.addStep(project.path, text);
    } catch (err) {
      flashToast(`Add step failed: ${(err as Error).message}`);
    }
  };

  // When a file is opened from inside the project preview, remember which
  // project we came from so the user can navigate back to the card view
  // after closing the file. Cleared whenever the user opens a fresh
  // preview directly from a card.
  const [previewBackPath, setPreviewBackPath] = createSignal<string | null>(null);

  const handleOpenFileFromPreview = (path: string) => {
    if (path.toLowerCase().endsWith('.md')) {
      setPreviewBackPath(previewPath());
      setPreviewPath(null);
      setModal({ path });
    } else if (path.toLowerCase().endsWith('.pdf')) {
      setPreviewBackPath(previewPath());
      setPdfPath(path);
    } else {
      // Non-md, non-pdf — opens externally, preview stays in place.
      void window.condash.openInEditor(path);
    }
  };

  const closeChildModal = (clear: () => void) => {
    clear();
    const back = previewBackPath();
    if (back) {
      setPreviewBackPath(null);
      setPreviewPath(back);
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
            classList={{ active: tab() === 'code' }}
            onClick={() => setTab('code')}
            disabled={!conceptionPath()}
          >
            Code
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

        <Show when={tab() === 'knowledge'}>
          <Suspense fallback={<div class="empty">Loading…</div>}>
            <Show
              when={knowledge()}
              fallback={
                <div class="empty">No knowledge/ directory under the selected conception path.</div>
              }
            >
              <KnowledgeView root={knowledge()!} onOpen={handleOpenKnowledgeFile} />
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
                <CodeRunRows
                  sessions={codeRunSessions()}
                  repos={repos() ?? []}
                  onPopOut={(id) => {
                    void window.condash.termSetSide(id, 'my').then(() => {
                      setTerminalOpen(true);
                      terminalHandle?.switchTo('my', id);
                    });
                  }}
                  onClose={(id) => void window.condash.termClose(id)}
                />
                <For each={repoGroups()}>
                  {(group) => (
                    <section class="repos-group" data-group={group.id}>
                      <h2 class="repos-group-header">
                        <span class="name">{group.label}</span>
                        <span class="count">{group.entries.length}</span>
                        <span class="rule" />
                      </h2>
                      <div class="repos-grid">
                        <For each={group.entries}>
                          {(repo) => (
                            <RepoRow
                              repo={repo}
                              slots={openWithSlots() ?? {}}
                              live={liveRepos().has(repo.name)}
                              onOpen={handleOpenInEditor}
                              onLaunch={(slot, path) => void handleLaunch(slot, path)}
                              onForceStop={(r) => void handleForceStop(r)}
                              onRun={(r) => void handleRunRepo(r)}
                            />
                          )}
                        </For>
                      </div>
                    </section>
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
        onEditStepText={handleEditStepText}
        onAddStep={handleAddStep}
        onChangeStatus={(p, s) => void handleDropOnColumn(p.path, s)}
        onOpenReadme={handleOpenReadmeFromPreview}
        onOpenFile={handleOpenFileFromPreview}
        onOpenInEditor={handleOpenInEditor}
        onOpenDeliverable={handleOpenDeliverableFromPreview}
      />

      <Show when={modal()}>
        <NoteModal
          state={modal()}
          onClose={() => closeChildModal(() => setModal(null))}
          onOpenInEditor={handleOpenInEditor}
          onOpenDeliverable={handleOpenDeliverable}
          onWikilink={handleWikilink}
        />
      </Show>

      <Show when={pdfPath()}>
        <PdfModal
          path={pdfPath()!}
          onClose={() => closeChildModal(() => setPdfPath(null))}
          onOpenInOs={handleOpenInEditor}
        />
      </Show>

      <TerminalPane
        open={terminalOpen()}
        onClose={() => setTerminalOpen(false)}
        launcherCommand={terminalPrefs()?.launcher_command ?? null}
        cwd={conceptionPath()}
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

function projectMatches(item: Project, needle: string): boolean {
  if (!needle) return true;
  return (
    item.title.toLowerCase().includes(needle) ||
    item.slug.toLowerCase().includes(needle) ||
    (item.summary?.toLowerCase().includes(needle) ?? false) ||
    (item.apps?.toLowerCase().includes(needle) ?? false)
  );
}

function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const [filter, setFilter] = createSignal('');
  const trimmedQuery = createMemo(() => filter().trim().toLowerCase());
  const filteredGroups = createMemo<Group[]>(() => {
    const q = trimmedQuery();
    const buckets = props.buckets;
    if (!q) return projectsTabGroups(buckets);
    const filtered = new Map<string, Project[]>();
    for (const [status, items] of buckets) {
      filtered.set(
        status,
        items.filter((it) => projectMatches(it, q)),
      );
    }
    return projectsTabGroups(filtered);
  });
  return (
    <div class="projects-stack">
      <div class="projects-filter">
        <input
          class="projects-filter-input"
          type="search"
          placeholder="Filter projects (title, slug, app, summary)…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <For each={filteredGroups()}>
        {(group) => (
          <GroupBlock
            group={group}
            collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
            forceOpen={trimmedQuery().length > 0 && group.items.length > 0}
            onOpen={props.onOpen}
            onToggleStep={props.onToggleStep}
            onDropProject={props.onDropProject}
          />
        )}
      </For>
    </div>
  );
}

function GroupBlock(props: {
  group: Group;
  /** When true, the section starts collapsed and shows an expand affordance. */
  collapsedByDefault?: boolean;
  /** Override collapsed state — e.g. when a search filter is active and the
   * group has matches, force it open so results aren't hidden. */
  forceOpen?: boolean;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const [over, setOver] = createSignal(false);
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null);
  const isOpen = (): boolean => {
    if (props.forceOpen) return true;
    const ux = userExpanded();
    if (ux !== null) return ux;
    return !props.collapsedByDefault;
  };

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
      classList={{ 'drag-over': over(), collapsed: !isOpen() }}
      data-status={props.group.status}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header
        class="group-header"
        onClick={() => setUserExpanded(!isOpen())}
        title={isOpen() ? 'Collapse section' : 'Expand section'}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="dot" aria-hidden="true" />
        <span class="name">{props.group.status}</span>
        <span class="count">{props.group.items.length}</span>
        <span class="rule" aria-hidden="true" />
      </header>
      <Show when={isOpen()}>
        <div class="group-body">
          <For each={props.group.items}>
            {(item) => <Card item={item} onOpen={props.onOpen} onToggleStep={props.onToggleStep} />}
          </For>
        </div>
      </Show>
    </section>
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
      data-status-card={props.item.status}
      draggable={isDraggable()}
      onDragStart={isDraggable() ? handleDragStart : undefined}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        <h3 class="title">
          <Show when={props.item.kind !== 'unknown'}>
            <span class="title-kind" data-kind={props.item.kind} title={props.item.kind}>
              <KindIcon kind={props.item.kind} />
            </span>
          </Show>
          <span class="title-text">{props.item.title}</span>
        </h3>
        <Show when={nextOpenStep(props.item)} keyed>
          {(step) => (
            <p class="summary next-step" data-marker={markerClass(step.marker)}>
              <span class="next-step-marker" aria-hidden="true">
                {step.marker === '~' ? '◐' : step.marker === '-' ? '⨯' : '○'}
              </span>
              {step.text}
            </p>
          )}
        </Show>
        <div class="meta">
          <Show when={props.item.apps}>
            <span class="meta-icon apps" title={props.item.apps}>
              <AppsIcon />
              {props.item.apps}
            </span>
          </Show>
          <Show when={props.item.deliverableCount > 0}>
            <span class="meta-icon" title="deliverables">
              <DownloadIcon />
              {props.item.deliverableCount}
            </span>
          </Show>
          <Show when={!(KNOWN_STATUSES as readonly string[]).includes(props.item.status)}>
            <span class="meta-icon warn" title={`Unknown status: ${props.item.status}`}>
              <WarnIcon />
              {props.item.status}
            </span>
          </Show>
          <span class="slug">{props.item.slug}</span>
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="meta-icon expander step-bar-right"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={`${props.item.steps.length} steps · click to ${expanded() ? 'collapse' : 'expand'}`}
            >
              <StepProgress counts={props.item.stepCounts} />
              <span class="expander-arrow">{expanded() ? '▾' : '▸'}</span>
            </button>
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

/** Prune `node` to only the subtree where some descendant title or path
 * matches `needle`. Returns null when nothing in the subtree matches. */
function filterKnowledgeTree(node: KnowledgeNode, needle: string): KnowledgeNode | null {
  if (!needle) return node;
  const titleHit = node.title.toLowerCase().includes(needle);
  const pathHit = node.path.toLowerCase().includes(needle);
  if (node.kind === 'file') {
    return titleHit || pathHit ? node : null;
  }
  const children = (node.children ?? [])
    .map((c) => filterKnowledgeTree(c, needle))
    .filter((c): c is KnowledgeNode => c !== null);
  if (children.length === 0 && !titleHit && !pathHit) return null;
  return { ...node, children };
}

function KnowledgeView(props: { root: KnowledgeNode; onOpen: (path: string) => void }) {
  const [filter, setFilter] = createSignal('');
  const trimmed = createMemo(() => filter().trim().toLowerCase());
  const filteredRoot = createMemo<KnowledgeNode | null>(() =>
    filterKnowledgeTree(props.root, trimmed()),
  );
  return (
    <div class="knowledge-pane">
      <div class="projects-filter">
        <input
          class="projects-filter-input"
          type="search"
          placeholder="Filter knowledge (title, path)…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <Show when={filteredRoot()} fallback={<div class="empty">No knowledge entries match.</div>}>
        <ul class="knowledge-tree knowledge-tree-root">
          <KnowledgeNodeView
            node={filteredRoot()!}
            depth={0}
            onOpen={props.onOpen}
            initiallyExpanded
            forceExpand={trimmed().length > 0}
          />
        </ul>
      </Show>
    </div>
  );
}

function KnowledgeNodeView(props: {
  node: KnowledgeNode;
  depth: number;
  onOpen: (path: string) => void;
  initiallyExpanded?: boolean;
  /** When true, ignore the local toggle and expand — used so a search filter
   * surfaces matches no matter how the user previously collapsed branches. */
  forceExpand?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(props.initiallyExpanded ?? props.depth === 0);
  const isExpanded = (): boolean => props.forceExpand || expanded();

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
          <span class="knowledge-icon">{isExpanded() ? '▾' : '▸'}</span>
          <span class="knowledge-title">{props.node.title}</span>
          <Show when={props.node.children}>
            <span class="knowledge-count">{props.node.children!.length}</span>
          </Show>
        </button>
        <Show when={isExpanded() && props.node.children}>
          <ul class="knowledge-tree">
            <For each={props.node.children}>
              {(child) => (
                <KnowledgeNodeView
                  node={child}
                  depth={props.depth + 1}
                  onOpen={props.onOpen}
                  forceExpand={props.forceExpand}
                />
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </li>
  );
}

type RepoGroup = { id: string; label: string; entries: RepoEntry[] };

function groupRepos(repos: readonly RepoEntry[]): RepoGroup[] {
  const childrenByParent = new Map<string, RepoEntry[]>();
  for (const r of repos) {
    if (!r.parent) continue;
    const arr = childrenByParent.get(r.parent) ?? [];
    arr.push(r);
    childrenByParent.set(r.parent, arr);
  }
  const primary: RepoEntry[] = [];
  const secondary: RepoEntry[] = [];
  const submoduleParents: { parent: RepoEntry; children: RepoEntry[] }[] = [];
  for (const r of repos) {
    if (r.parent) continue;
    const kids = childrenByParent.get(r.name);
    if (kids && kids.length > 0) {
      submoduleParents.push({ parent: r, children: kids });
    } else if (r.kind === 'primary') {
      primary.push(r);
    } else {
      secondary.push(r);
    }
  }
  const groups: RepoGroup[] = [];
  if (primary.length > 0) groups.push({ id: 'primary', label: 'PRIMARY', entries: primary });
  for (const { parent, children } of submoduleParents) {
    groups.push({
      id: parent.name,
      label: parent.name.toUpperCase(),
      entries: [parent, ...children],
    });
  }
  if (secondary.length > 0)
    groups.push({ id: 'secondary', label: 'SECONDARY', entries: secondary });
  return groups;
}

type RepoStatus = 'missing' | 'unknown' | 'clean' | 'dirty';

/** Synthesise the primary checkout as a Worktree-shaped row when the data
 * layer didn't return any worktrees (e.g. repo missing or git failed). The
 * branch is unknown so we leave it null. */
function ensureWorktrees(repo: RepoEntry): Worktree[] {
  if (repo.worktrees && repo.worktrees.length > 0) return repo.worktrees;
  return [
    {
      path: repo.path,
      branch: null,
      primary: true,
      dirty: repo.dirty,
    },
  ];
}

/** Sort: primary checkout first, then worktrees alphabetically. */
function orderedWorktrees(repo: RepoEntry): Worktree[] {
  const list = ensureWorktrees(repo).slice();
  list.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return (a.branch ?? '').localeCompare(b.branch ?? '');
  });
  return list;
}

/** Per-card status pill text — collapses worktree dirtiness into one of:
 * "CLEAN", "1 BRANCH DIRTY", "N BRANCHES DIRTY", "MISSING", "?". */
function cardStatusLabel(repo: RepoEntry): string {
  if (repo.missing) return 'MISSING';
  const wts = ensureWorktrees(repo);
  const dirtyCount = wts.filter((w) => (w.dirty ?? 0) > 0).length;
  if (dirtyCount === 0) {
    if (wts.every((w) => w.dirty === null || w.dirty === undefined)) return '?';
    return 'CLEAN';
  }
  return dirtyCount === 1 ? '1 BRANCH DIRTY' : `${dirtyCount} BRANCHES DIRTY`;
}

function cardStatus(repo: RepoEntry): RepoStatus {
  if (repo.missing) return 'missing';
  const wts = ensureWorktrees(repo);
  if (wts.every((w) => w.dirty === null || w.dirty === undefined)) return 'unknown';
  return wts.some((w) => (w.dirty ?? 0) > 0) ? 'dirty' : 'clean';
}

function RepoRow(props: {
  repo: RepoEntry;
  slots: OpenWithSlots;
  /** True when at least one terminal session is currently running for this repo. */
  live?: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry) => void;
}) {
  const status = (): RepoStatus => cardStatus(props.repo);
  const displayName = (): string => {
    if (props.repo.parent && props.repo.name.startsWith(`${props.repo.parent}/`)) {
      return props.repo.name.slice(props.repo.parent.length + 1);
    }
    return props.repo.name;
  };

  const branchStatus = (wt: Worktree): RepoStatus => {
    if (props.repo.missing) return 'missing';
    if (wt.dirty == null) return 'unknown';
    return wt.dirty === 0 ? 'clean' : 'dirty';
  };

  return (
    <article
      class="repo-row"
      classList={{
        missing: props.repo.missing,
        submodule: !!props.repo.parent,
      }}
      data-status={status()}
    >
      <header class="repo-head">
        <span class="repo-name">{displayName()}</span>
        <span class="repo-status-badge" data-status={status()}>
          {cardStatusLabel(props.repo)}
        </span>
        <Show when={props.live}>
          <span class="repo-live-badge" title="A terminal session is running for this repo">
            LIVE
          </span>
        </Show>
        <span class="spacer" />
        <span class="repo-kind-tag" title={`Configured under repositories.${props.repo.kind}`}>
          {props.repo.parent ? 'SUB' : 'REPO'}
        </span>
      </header>
      <ul class="branches">
        <For each={orderedWorktrees(props.repo)}>
          {(wt) => (
            <li class="branch-row" data-status={branchStatus(wt)}>
              <span class="branch-dot" aria-hidden="true" />
              <span class="branch-name">{wt.branch ?? '(detached)'}</span>
              <span class="branch-role">{wt.primary ? 'CHECKOUT' : 'WORKTREE'}</span>
              <Show when={(wt.dirty ?? 0) > 0}>
                <span class="branch-dirty">{wt.dirty} dirty</span>
              </Show>
              <Show when={wt.primary && props.live}>
                <span class="branch-live-dot" title="Running" aria-label="Running" />
              </Show>
              <span class="spacer" />
              <div class="branch-actions">
                <Show when={wt.primary}>
                  <button
                    class="repo-action run"
                    onClick={() => props.onRun(props.repo)}
                    disabled={props.repo.missing}
                    title="Run configured run: command"
                  >
                    ▶
                  </button>
                  <Show when={props.repo.hasForceStop}>
                    <button
                      class="repo-action icon warn"
                      onClick={() => props.onForceStop(props.repo)}
                      disabled={props.repo.missing}
                      title="Force-stop"
                    >
                      ⏹
                    </button>
                  </Show>
                </Show>
                <button
                  class="repo-action icon"
                  onClick={() => props.onOpen(wt.path)}
                  disabled={props.repo.missing}
                  title="Open in OS file manager"
                >
                  📁
                </button>
                <For each={LAUNCHER_SLOTS}>
                  {(slot) => (
                    <Show when={props.slots[slot]}>
                      <button
                        class="repo-action icon"
                        onClick={() => props.onLaunch(slot, wt.path)}
                        disabled={props.repo.missing}
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
      <span class="repo-path" title={props.repo.path}>
        {props.repo.path}
      </span>
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
