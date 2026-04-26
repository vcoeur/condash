import { render } from 'solid-js/web';
import { createResource, createSignal, For, Show, Suspense } from 'solid-js';
import type { Project } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import './styles.css';

type Group = { status: string; items: Project[] };

const UNKNOWN = '?';

function groupByStatus(items: Project[]): Group[] {
  const buckets = new Map<string, Project[]>();
  for (const status of KNOWN_STATUSES) buckets.set(status, []);
  buckets.set(UNKNOWN, []);

  for (const item of items) {
    const key = (KNOWN_STATUSES as readonly string[]).includes(item.status)
      ? item.status
      : UNKNOWN;
    buckets.get(key)!.push(item);
  }

  const ordered: Group[] = [];
  for (const status of KNOWN_STATUSES) {
    ordered.push({ status, items: buckets.get(status)! });
  }
  ordered.push({ status: UNKNOWN, items: buckets.get(UNKNOWN)! });
  return ordered.filter((g) => g.items.length > 0 || g.status !== UNKNOWN);
}

function App() {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>(null);
  const [refreshKey, setRefreshKey] = createSignal(0);

  void window.condash.getConceptionPath().then(setConceptionPath);

  const [projects] = createResource(
    () => [conceptionPath(), refreshKey()] as const,
    async ([path]) => {
      if (!path) return [] as Project[];
      return window.condash.listProjects();
    },
  );

  const handlePick = async () => {
    const picked = await window.condash.pickConceptionPath();
    if (picked) {
      setConceptionPath(picked);
      setRefreshKey((k) => k + 1);
    }
  };

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  const handleOpen = (path: string) => {
    void window.condash.openInEditor(path);
  };

  return (
    <div class="app">
      <header class="toolbar">
        <h1>condash</h1>
        <span class="path">{conceptionPath() ?? '(no conception path)'}</span>
        <button onClick={handleRefresh} disabled={!conceptionPath()}>
          Refresh
        </button>
        <button onClick={handlePick}>
          {conceptionPath() ? 'Change…' : 'Choose folder…'}
        </button>
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
        <Suspense fallback={<div class="empty">Loading…</div>}>
          <Show
            when={(projects() ?? []).length > 0}
            fallback={<div class="empty">No projects found under projects/.</div>}
          >
            <div class="columns">
              <For each={groupByStatus(projects() ?? [])}>
                {(group) => (
                  <section class="column" data-status={group.status}>
                    <header class="column-header">
                      <span class="name">{group.status}</span>
                      <span class="count">{group.items.length}</span>
                    </header>
                    <div class="column-body">
                      <For each={group.items}>
                        {(item) => (
                          <article
                            class="row"
                            onClick={() => handleOpen(item.path)}
                            title={item.path}
                          >
                            <span class="title">{item.title}</span>
                            <div class="meta">
                              <span class="slug">{item.slug}</span>
                              <Show when={item.kind !== 'unknown'}>
                                <span class="badge">{item.kind}</span>
                              </Show>
                              <Show when={item.apps}>
                                <span class="badge">{item.apps}</span>
                              </Show>
                              <Show
                                when={
                                  !(KNOWN_STATUSES as readonly string[]).includes(item.status)
                                }
                              >
                                <span class="badge warn">!? {item.status}</span>
                              </Show>
                            </div>
                          </article>
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
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
render(() => <App />, root);
