import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from '../logs-redact';
import type { DashboardConfig, DashboardEvent, TabSummary } from '../../shared/types';

let undiciShimInstalled = false;
/**
 * Work around a runtime incompatibility between the pi SDK's bundled undici
 * (pinned at 8.5.0) and Electron 33's Node 20.18 runtime.
 *
 * That undici reads `markAsUncloneable` from `node:worker_threads` at module
 * load and assigns it to `webidl.util.markAsUncloneable` with no fallback.
 * Node 20.18 (what Electron 33 ships) doesn't export the symbol, so the
 * property is `undefined` and the first fetch Request/Response/Headers
 * construction throws "webidl.util.markAsUncloneable is not a function" — which
 * breaks every dashboard LLM call (the periodic summaries and the Settings
 * "Test connection" button alike). Newer undici guards this with
 * `|| (() => {})`; install the same no-op on the shared builtin's exports
 * *before* the SDK pulls undici in. The mark only gates structuredClone across
 * worker threads, which the dashboard never does, so a no-op is safe.
 *
 * A real CommonJS `require` (via createRequire) is deliberate: `await
 * import('node:worker_threads')` hands back an esbuild ESM-interop wrapper whose
 * mutation may not reach undici's `require()` view of the same module.
 */
function ensureUndiciElectronShim(): void {
  if (undiciShimInstalled) return;
  undiciShimInstalled = true;
  // `process.execPath` (the absolute Electron binary path) is just a valid base
  // for createRequire — esbuild leaves `import.meta.url` undefined in the CJS
  // main bundle, and the base is irrelevant for resolving a builtin anyway.
  const nodeRequire = createRequire(process.execPath);
  const workerThreads = nodeRequire('node:worker_threads') as {
    markAsUncloneable?: (value: unknown) => void;
  };
  if (typeof workerThreads.markAsUncloneable !== 'function') {
    workerThreads.markAsUncloneable = () => {};
  }
}

/** The fields the model is asked to produce for a single tab. */
export interface TabSummaryResult {
  title: string;
  contextLines: string[];
  currentAction: string;
}

/** The fields the model is asked to produce for the cross-tab overview. */
export interface OverviewResult {
  overview: string[];
  events: string[];
}

/** Tab metadata + recent output handed to the summarizer for one tab. */
export interface TabInput {
  sid: string;
  cmd?: string;
  cwd?: string;
  recentText: string;
  prior?: TabSummary;
}

const MAX_RECENT_CHARS = 6000;
const MAX_TITLE_WORDS = 6;
const MAX_CONTEXT_LINES = 4;

/** Hard ceiling on a single pi completion. The dashboard makes a tool-free
 *  summarization call, so a slow but live model finishes well inside this; the
 *  cap exists so a black-holed connection can't wedge the engine's `inFlight`
 *  guard forever (it is only cleared once the await settles). Mirrors the task
 *  scheduler bounding its headless runs with a timeout. */
const COMPLETION_TIMEOUT_MS = 60_000;

/** Last pi-completion failure within the current cycle, surfaced to the renderer
 *  so a silent no-op (bad key, unknown model, network) is explainable. The
 *  engine clears it at the start of each cycle and reads it after. */
let lastError: string | null = null;
/** Read the last summarization error (null when the last cycle was clean). */
export function getSummarizerError(): string | null {
  return lastError;
}
/** Reset the captured error — called by the engine at the start of each cycle. */
export function clearSummarizerError(): void {
  lastError = null;
}

/** Pull the first balanced-looking JSON object out of an LLM reply (which may
 *  wrap it in prose or a ```json fence despite instructions) and parse it.
 *  Returns null when no parseable object is present. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

/** Parse the model reply for a single tab into a `TabSummaryResult`, or null if
 *  it lacks a usable title. Exported for unit testing without a live model. */
export function parseTabSummary(reply: string): TabSummaryResult | null {
  const obj = extractJsonObject(reply);
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const title = typeof record.title === 'string' ? clampWords(record.title, MAX_TITLE_WORDS) : '';
  if (!title) return null;
  return {
    title,
    contextLines: asStringArray(record.contextLines, MAX_CONTEXT_LINES),
    currentAction: typeof record.currentAction === 'string' ? record.currentAction.trim() : '',
  };
}

/** Parse the model reply for the cross-tab overview, or null on garbage. */
export function parseOverview(reply: string): OverviewResult | null {
  const obj = extractJsonObject(reply);
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const overview = asStringArray(record.overview, 5);
  if (overview.length === 0) return null;
  return { overview, events: asStringArray(record.events, 3) };
}

// Guardrails below were tuned against an eval of a week of real terminal logs on
// deepseek-v4-flash: name the tool from cmd/status (never invent one), don't read
// the user's draft prompt line as an action, distinguish working/awaiting/idle,
// and title the work rather than the tool.
const TAB_SYSTEM_PROMPT = [
  'You summarize a single terminal tab for a developer dashboard.',
  'You are given the tab command/cwd, a prior summary (possibly stale), and the',
  'most recent terminal output.',
  'Judge the tab state from the LATEST output, not the most dramatic or alarming',
  'line. When the latest output disagrees with the prior summary, trust the latest',
  'output. Prefer literal description over alarming interpretation.',
  'Name the running program from the tab command and any status line (for example',
  '"claude", "opencode", "pi", "make dev"). Never invent a tool name; if it is',
  'unclear, describe the activity without naming a tool.',
  'A line after a "❯" or ">" prompt marker is text the user is typing or about to',
  'send. It is not something the tab is doing or has done — never report it as the',
  'current action or as an event.',
  'Distinguish three states. (1) Working: output is still progressing — say what',
  'it is doing. (2) Awaiting the user: the program asked a specific question or',
  'shows an interactive menu/prompt that needs an answer — say what answer it',
  'awaits. (3) Idle: the work finished or nothing is pending — say so, and you may',
  'add the last meaningful thing it did. An agent resting at an empty prompt after',
  'finishing is idle, not blocked on you.',
  'Treat informational notices and recoverable warnings as background noise (for',
  'example "workspace not trusted", "N permissions ignored", deprecation or auth',
  'notices): never report them as the current action or a blocker.',
  'Reply with ONLY a JSON object, no markdown fence:',
  '{"title": string (<=5 words naming the work, project, or subject the tab is',
  ' about — not the program; use the program or directory name as the title only',
  ' when the tab has done no real work yet),',
  ' "contextLines": string[] (1-4 short factual lines: what this tab is for and recent progress),',
  ' "currentAction": string (one short line for the state above: what is happening',
  ' now, the answer it awaits, or the final/idle state)}.',
].join(' ');

const OVERVIEW_SYSTEM_PROMPT = [
  'You summarize what a developer is doing across several terminal tabs.',
  'You are given each tab id and its current summary.',
  'Describe the overall activity factually. Do not escalate one tab into a',
  'cross-tab crisis. Idle tabs resting at a prompt are the normal state, not',
  'blocks: only describe the developer as waiting or blocked for a tab whose',
  'summary says the program asked a question or needs a selection. Do not',
  'aggregate several idle prompts into "waiting for input everywhere". Treat',
  'warnings and recoverable errors as routine.',
  'Reply with ONLY a JSON object, no markdown fence:',
  '{"overview": string[] (2-5 short lines describing the overall current activity,',
  ' referencing tabs by title when useful),',
  ' "events": string[] (0-3 short notable cross-tab events worth remembering, else [])}.',
].join(' ');

/** Assemble the per-tab user prompt. Every field that carries captured terminal
 *  content — the command, cwd, the prior summary, and the recent output — is run
 *  through `redactSecrets` here, the single chokepoint before the text is POSTed
 *  to the LLM, so a secret printed in a watched tab never leaves the machine in
 *  clear text. Locally stored/displayed data (titles, state.json) is untouched.
 *  Exported for unit testing. */
export function buildTabUserPrompt(input: TabInput): string {
  const lines: string[] = [];
  lines.push(`Tab command: ${input.cmd ? redactSecrets(input.cmd) : '(shell)'}`);
  if (input.cwd) lines.push(`Working directory: ${redactSecrets(input.cwd)}`);
  if (input.prior) {
    lines.push('');
    lines.push('Prior summary:');
    lines.push(
      redactSecrets(
        JSON.stringify({
          title: input.prior.title,
          contextLines: input.prior.contextLines,
          currentAction: input.prior.currentAction,
        }),
      ),
    );
  }
  lines.push('');
  lines.push('Most recent terminal output:');
  lines.push('"""');
  lines.push(redactSecrets(input.recentText.slice(-MAX_RECENT_CHARS)));
  lines.push('"""');
  return lines.join('\n');
}

/** Assemble the cross-tab overview user prompt. The per-tab title/currentAction
 *  it embeds are model-derived (already from redacted input going forward), but
 *  redact them here too so this prompt is uniformly secret-free at the wire.
 *  Exported for unit testing. */
export function buildOverviewUserPrompt(tabs: TabSummary[]): string {
  const lines = ['Open tabs and their current summaries:', ''];
  for (const tab of tabs) {
    lines.push(`- [${tab.sid}] ${redactSecrets(tab.title)}: ${redactSecrets(tab.currentAction)}`);
  }
  return lines.join('\n');
}

/** Extract the concatenated assistant text from a pi `AgentMessage`. */
function agentMessageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

/**
 * Reject if `promise` does not settle within `ms`, otherwise pass its result
 * through. The timer is always cleared so a fast resolve never leaks a pending
 * timeout, and a late rejection from the racing promise (after the timeout has
 * already won) is swallowed so it can't surface as an unhandled rejection.
 * Exported for unit testing.
 *
 * @param promise - The work to bound.
 * @param ms - Deadline in milliseconds.
 * @param label - Prefix for the timeout error message.
 * @returns The resolved value of `promise` when it wins the race.
 * @throws when the deadline elapses first.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  // The original promise stays pending when the timeout wins; attach a no-op
  // catch so a later rejection of it is not flagged as unhandled.
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a single tool-free completion through the pi coding-agent SDK against the
 * configured provider/model. Fully isolated: in-memory auth + model registry +
 * session, discovery (skills, extensions, context files like AGENTS.md) all
 * disabled, no tools — the model sees only the system + user prompt we pass.
 *
 * When `config.baseUrl` is set the model id is registered against that
 * OpenAI-compatible endpoint (DeepSeek's own gateway, a self-hosted proxy, an
 * opencode-go server, …), so any model name the endpoint serves resolves. With
 * no `baseUrl` the id must be a built-in provider model (e.g. `deepseek-v4-flash`).
 *
 * The SDK is imported dynamically so it never enters the CLI bundle or the
 * app's startup path (the engine only calls this when the dashboard is enabled).
 *
 * @throws when the configured model is unknown or the provider errors.
 */
async function runPiCompletion(
  config: DashboardConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  if (!config.apiKey) throw new Error('dashboard: no API key configured');
  ensureUndiciElectronShim();
  const { AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader, createAgentSession } =
    await import('@earendil-works/pi-coding-agent');

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(config.provider, config.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  // A custom base URL means an OpenAI-compatible endpoint with a model id that
  // may not exist in the built-in catalogue — register it so `find()` resolves.
  // This replaces the built-in models for `config.provider`, which is fine: the
  // dashboard only ever resolves this one model.
  if (config.baseUrl) {
    modelRegistry.registerProvider(config.provider, {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      api: 'openai-completions',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
  }
  const model = modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(`dashboard: unknown model ${config.provider}/${config.model}`);
  }

  // Neutral working dir + agent dir: with discovery and tools disabled nothing
  // is read from them, but the loader requires both to exist.
  const agentDir = join(tmpdir(), 'condash-dashboard-pi');
  await mkdir(agentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    cwd: agentDir,
    agentDir,
    systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    cwd: agentDir,
    noTools: 'all',
  });

  let text = '';
  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'turn_end') text += agentMessageText(event.message);
  });
  try {
    // Bound the completion: a black-holed network connection must not hang the
    // await forever (the engine's single-flight guard only clears once it
    // settles). `dispose()` below tears down the session's HTTP client.
    await withTimeout(session.prompt(userPrompt), COMPLETION_TIMEOUT_MS, 'dashboard: completion');
  } finally {
    unsubscribe();
    session.dispose();
  }
  return text;
}

/** Summarize one terminal tab. Returns null when the model reply can't be
 *  parsed or the call fails — the engine then keeps the prior summary. */
export async function summarizeTab(
  config: DashboardConfig,
  input: TabInput,
): Promise<TabSummaryResult | null> {
  try {
    const reply = await runPiCompletion(config, TAB_SYSTEM_PROMPT, buildTabUserPrompt(input));
    return parseTabSummary(reply);
  } catch (err) {
    lastError = (err as Error).message;
    process.stderr.write(`condash dashboard: summarizeTab failed: ${(err as Error).message}\n`);
    return null;
  }
}

/** Build the cross-tab overview from the current per-tab summaries. Returns
 *  null when there is nothing to summarize or the call fails. */
export async function synthesizeOverview(
  config: DashboardConfig,
  tabs: TabSummary[],
): Promise<OverviewResult | null> {
  if (tabs.length === 0) return null;
  try {
    const reply = await runPiCompletion(
      config,
      OVERVIEW_SYSTEM_PROMPT,
      buildOverviewUserPrompt(tabs),
    );
    return parseOverview(reply);
  } catch (err) {
    lastError = (err as Error).message;
    process.stderr.write(
      `condash dashboard: synthesizeOverview failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

/**
 * Run a minimal completion to verify the configured key / base URL / model
 * actually work. Used by the Settings "Test connection" button. Never throws —
 * resolves to `{ ok: false, error }` so the UI can show the failure inline.
 */
export async function testDashboardConnection(
  config: DashboardConfig,
): Promise<{ ok: boolean; error?: string }> {
  if (!config.apiKey) return { ok: false, error: 'No API key configured.' };
  try {
    const reply = await runPiCompletion(
      config,
      'You are a connection test. Reply with the single word OK.',
      'Reply with OK.',
    );
    if (!reply.trim()) return { ok: false, error: 'The endpoint returned an empty response.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Build a dashboard event from a one-line description, stamped now. */
export function makeEvent(text: string, at: number): DashboardEvent {
  return { at, text };
}
