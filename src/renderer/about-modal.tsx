import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Modal } from './modal';
import './about-modal.css';

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
  let cancelled = false;

  onMount(() => {
    // Cancellation guard so the .then() doesn't setInfo into a disposed
    // root if the modal closes before the IPC resolves.
    void window.condash.getAppInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });
  });
  onCleanup(() => {
    cancelled = true;
  });

  return (
    <Modal class="about-modal" ariaLabel="About Condash" title="About" onClose={props.onClose}>
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
    </Modal>
  );
}
