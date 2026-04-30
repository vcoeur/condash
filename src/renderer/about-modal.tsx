import { createSignal, onMount, Show } from 'solid-js';

interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
}

/** "About Condash" modal — opened from `Help → About Condash` in the
 * application menu. Pulls runtime version metadata from main on first
 * mount so the user sees the build they're actually running. */
export function AboutModal(props: { onClose: () => void }) {
  const [info, setInfo] = createSignal<AppInfo | null>(null);

  onMount(() => {
    void window.condash.getAppInfo().then(setInfo);
  });

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div
        class="modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-label="About Condash"
        onClick={(e) => e.stopPropagation()}
      >
        <header class="modal-head">
          <span class="modal-title">About</span>
          <span class="modal-head-spacer" />
          <button
            class="modal-button"
            onClick={props.onClose}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div class="about-modal-body">
          <h2 class="about-app-name">{info()?.name ?? 'Condash'}</h2>
          <p class="about-tagline">Markdown project dashboard for the conception tree.</p>
          <Show when={info()}>
            {(i) => (
              <dl class="about-versions">
                <dt>Version</dt>
                <dd>{i().version}</dd>
                <dt>Electron</dt>
                <dd>{i().electron}</dd>
                <dt>Chrome</dt>
                <dd>{i().chrome}</dd>
                <dt>Node</dt>
                <dd>{i().node}</dd>
              </dl>
            )}
          </Show>
          <p class="about-links">
            <a
              href="https://github.com/vcoeur/condash"
              onClick={(e) => {
                e.preventDefault();
                void window.condash.openExternal('https://github.com/vcoeur/condash');
              }}
            >
              github.com/vcoeur/condash
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
