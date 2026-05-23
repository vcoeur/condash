/**
 * Tasks — reusable, parameterized agent prompts.
 *
 * A task pairs a referenced agent with a markdown prompt that carries fillable
 * `{markers}`. The user fills the markers in the Tasks pane, then runs the task:
 * condash spawns the agent in a fresh terminal tab and types the filled prompt.
 *
 * This shared module is the single parser for the marker grammar (so the pane's
 * fill form and the main process's `listTasks` agree on what a prompt needs) and
 * builds the `{APP_*}` / `{PROJECT_*}` context families the reserved pickers feed
 * into `substitute`. It is pure and serialisable — no `fs`, no Electron.
 */
import { MARKER_RE, projectContext, type ProjectLike } from './action-template';

/** On-disk task definition: `task.json` config (`name` / `agent` / `submit`)
 *  plus the raw `prompt.md` body. The slug is the directory name, carried
 *  separately by the IPC verbs (it is not stored inside `task.json`). */
export interface TaskDef {
  name: string;
  /** Referenced agent name (`<harness>-<model_variant>`). May dangle. */
  agent: string;
  /** Press Enter after typing the filled prompt. Default true. */
  submit: boolean;
  /** Raw markdown prompt with `{markers}`. */
  prompt: string;
}

/** Renderer-facing task summary — one card per task in the Tasks pane. */
export interface TaskListItem {
  slug: string;
  name: string;
  agent: string;
  /** Whether `agent` resolves to a defined agent. False → card warns, Run off. */
  agentPresent: boolean;
  /** Ordered, unique markers parsed from the prompt (drives the fill form). */
  markers: Marker[];
}

/** One fillable marker parsed from a prompt. `default` is `''` for a bare
 *  `{KEY}`; first occurrence of a repeated key wins the default. */
export interface Marker {
  key: string;
  default: string;
}

/** Reserved `{APP}` family — picking an app populates all of these at once. */
export const APP_TOKENS = ['APP', 'APP_NAME', 'APP_PATH'] as const;

/** Reserved `{PROJECT}` family — picking a project populates all of these. */
export const PROJECT_TOKENS = [
  'PROJECT',
  'PROJECT_SLUG',
  'PROJECT_PATH',
  'PROJECT_BRANCH',
  'PROJECT_BASE',
  'PROJECT_TITLE',
] as const;

const APP_TOKEN_SET: ReadonlySet<string> = new Set(APP_TOKENS);
const PROJECT_TOKEN_SET: ReadonlySet<string> = new Set(PROJECT_TOKENS);

/** True when `key` is one of the reserved `{APP_*}` tokens. */
export function isAppToken(key: string): boolean {
  return APP_TOKEN_SET.has(key);
}

/** True when `key` is one of the reserved `{PROJECT_*}` tokens. */
export function isProjectToken(key: string): boolean {
  return PROJECT_TOKEN_SET.has(key);
}

/**
 * Parse a prompt into its ordered, unique markers. A key that appears more than
 * once yields a single marker (first occurrence's default wins). Reserved
 * `{APP_*}` / `{PROJECT_*}` tokens are returned alongside plain ones — callers
 * decide which render as pickers vs. text fields via `isAppToken` /
 * `isProjectToken`.
 */
export function extractMarkers(prompt: string): Marker[] {
  const re = new RegExp(MARKER_RE.source, 'g');
  const seen = new Map<string, Marker>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const key = m[1];
    if (!seen.has(key)) seen.set(key, { key, default: m[2] ?? '' });
  }
  return [...seen.values()];
}

/** Minimal app shape the `{APP_*}` context builder needs. `name` is the repo
 *  directory name (e.g. `condash`); `path` its absolute checkout path. */
export interface AppLike {
  name: string;
  path: string;
}

/**
 * Build the `{APP_*}` substitution family for a chosen app. The bare `{APP}`
 * resolves to the `@alias` (e.g. `@condash`), matching the conception Apps-table
 * convention; `{APP_NAME}` is the bare repo name and `{APP_PATH}` its absolute
 * path. Returns an empty bag when no app is chosen so unfilled tokens stay
 * verbatim.
 */
export function appContext(app: AppLike | null): Record<string, string> {
  if (!app) return {};
  return {
    APP: `@${app.name}`,
    APP_NAME: app.name,
    APP_PATH: app.path,
  };
}

/**
 * Build the `{PROJECT_*}` substitution family for a chosen project. Bare
 * `{PROJECT}` resolves to the slug; the sub-tokens expose slug / rel-path /
 * branch / base / title. Reuses `projectContext` so the rel-path computation
 * matches the project-action path exactly. Empty bag when no project is chosen.
 */
export function projectTokenContext(
  project: ProjectLike | null,
  conceptionPath?: string,
): Record<string, string> {
  if (!project) return {};
  const ctx = projectContext(project, conceptionPath);
  return {
    PROJECT: ctx.slug,
    PROJECT_SLUG: ctx.slug,
    PROJECT_PATH: ctx.relPath,
    PROJECT_BRANCH: ctx.branch,
    PROJECT_BASE: ctx.base,
    PROJECT_TITLE: ctx.title,
  };
}
