import type { JSX } from 'solid-js';

interface WelcomeScreenProps {
  conceptionPath: string;
  onOpenTree: () => void;
  onTakeTour: () => void;
  onOpenDocs: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}

/**
 * Empty-state surface shown when the conception tree is reachable but has no
 * items in `projects/` and no entries in `knowledge/`. Three actions match the
 * three things a brand-new user typically wants to do next: open the tree in
 * the OS file manager (so they can drop a README in by hand or via their
 * editor / a Claude skill), read the bundled welcome doc, or jump out to the
 * public site.
 *
 * The dismiss link writes `welcome.dismissed = true` to settings.json via the
 * onDismiss callback. Once content lands in the tree the screen stops
 * appearing on its own — the dismiss is for users who want it gone before
 * adding their first item (e.g. opening a tree they manage entirely from
 * their editor).
 */
export function WelcomeScreen(props: WelcomeScreenProps): JSX.Element {
  return (
    <div class="welcome-screen" role="region" aria-label="Welcome to condash">
      <div class="welcome-inner">
        <h1 class="welcome-heading">Welcome to condash</h1>
        <p class="welcome-tagline">A dashboard for the Markdown you already write.</p>
        <p class="welcome-path">
          Tree: <code>{props.conceptionPath}</code>{' '}
          <button
            type="button"
            class="welcome-path-edit"
            onClick={props.onOpenSettings}
            title="Open configuration editor"
          >
            edit
          </button>
        </p>

        <p class="welcome-intro">
          Your tree is empty. condash renders projects, incidents, and documents stored as plain
          Markdown under <code>projects/YYYY-MM/&lt;item&gt;/README.md</code>. To get started:
        </p>

        <div class="welcome-cards">
          <button type="button" class="welcome-card" onClick={props.onOpenTree}>
            <div class="welcome-card-title">Open my tree</div>
            <div class="welcome-card-body">
              Open the conception directory in your OS file manager so you can drop in your first
              README, or open it in your editor. condash picks up changes live.
            </div>
          </button>

          <button type="button" class="welcome-card" onClick={props.onTakeTour}>
            <div class="welcome-card-title">Read the welcome doc</div>
            <div class="welcome-card-body">
              The bundled docs are available offline through the Help menu. The welcome page walks
              you through everything condash does.
            </div>
          </button>

          <button type="button" class="welcome-card" onClick={props.onOpenDocs}>
            <div class="welcome-card-title">Open the documentation site</div>
            <div class="welcome-card-body">
              Visit <span class="welcome-card-url">condash.vcoeur.com</span> for the full Diátaxis
              tree: tutorials, guides, reference, and the design rationale.
            </div>
          </button>
        </div>

        <p class="welcome-dismiss">
          <button type="button" class="welcome-dismiss-link" onClick={props.onDismiss}>
            Don't show this again
          </button>
        </p>
      </div>
    </div>
  );
}
