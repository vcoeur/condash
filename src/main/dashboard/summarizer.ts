import { createRequire } from 'node:module';
import { redactSecrets } from '../logs-redact';
import type {
  ActivityStage,
  DashboardConfig,
  DashboardEvent,
  TabState,
  TabSummary,
} from '../../shared/types';
import type { TabProvenance } from './provenance';

let undiciShimInstalled = false;
/**
 * Work around a runtime incompatibility between the undici behind Electron 33's
 * global `fetch` and its Node 20.18 runtime.
 *
 * undici reads `markAsUncloneable` from `node:worker_threads` at module load and
 * assigns it to `webidl.util.markAsUncloneable` with no fallback. Node 20.18
 * (what Electron 33 ships) doesn't export the symbol, so the property is
 * `undefined` and the first fetch Request/Response/Headers construction throws
 * "webidl.util.markAsUncloneable is not a function" — which breaks every
 * dashboard LLM call (the periodic summaries and the Settings "Test connection"
 * button alike). Newer undici guards this with `|| (() => {})`; install the same
 * no-op on the shared builtin's exports *before* the first `fetch`. The mark only
 * gates structuredClone across worker threads, which the dashboard never does, so
 * a no-op is safe.
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
  /** Coarse state used to colour the card; defaulted to `idle` when the reply
   *  omits or garbles it. */
  state: TabState;
  /** Finer-grained work stage; defaulted to `idle` when the reply omits or
   *  garbles it. */
  activity: ActivityStage;
  /** The one-line question the tab is blocking on when `state === 'awaiting'`. */
  awaitingPrompt?: string;
}

/** The card-model facts handed to the writer model to compose a subtitle. */
export interface SubtitleInput {
  title: string;
  currentAction: string;
  contextLines: string[];
  activity: ActivityStage;
  state: TabState;
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
/** Hard ceiling on the writer-model subtitle (one sentence). */
const MAX_SUBTITLE_CHARS = 140;

/** Hard ceiling on a single pi completion. The dashboard makes a tool-free
 *  summarization call, so a slow but live model finishes well inside this; the
 *  cap exists so a black-holed connection can't wedge the engine's `inFlight`
 *  guard forever (it is only cleared once the await settles). Mirrors the task
 *  scheduler bounding its headless runs with a timeout. */
const COMPLETION_TIMEOUT_MS = 60_000;

/** DeepSeek's built-in endpoint, used when no `baseUrl` is configured. */
const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';

/** Sent on every completion request. Some OpenAI-compatible gateways (notably
 *  opencode.ai's Zen gateway) sit behind Cloudflare and 403 the default Node
 *  `fetch` user-agent; a named UA gets through and identifies the caller. */
const DASHBOARD_USER_AGENT = 'condash-dashboard';

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

/** Trim and hard-cap a string to `maxChars`, returning `''` for a non-string. */
function clampChars(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

const TAB_STATES: readonly TabState[] = ['working', 'awaiting', 'idle', 'error'];

/** Coerce a model-supplied `state` value to a known `TabState`, defaulting to
 *  `idle` for anything missing or unrecognised — so an old reply or a flaky
 *  model can never break the colour rendering. */
function coerceTabState(value: unknown): TabState {
  return typeof value === 'string' && (TAB_STATES as readonly string[]).includes(value)
    ? (value as TabState)
    : 'idle';
}

const ACTIVITY_STAGES: readonly ActivityStage[] = [
  'implementing',
  'designing',
  'reviewing',
  'making-pr',
  'documenting',
  'testing',
  'debugging',
  'researching',
  'awaiting',
  'idle',
];

/** Coerce a model-supplied `activity` value to a known `ActivityStage`,
 *  defaulting to `idle` for anything missing or unrecognised. */
function coerceActivity(value: unknown): ActivityStage {
  return typeof value === 'string' && (ACTIVITY_STAGES as readonly string[]).includes(value)
    ? (value as ActivityStage)
    : 'idle';
}

/** Parse the model reply for a single tab into a `TabSummaryResult`, or null if
 *  it lacks a usable title. Exported for unit testing without a live model. */
export function parseTabSummary(reply: string): TabSummaryResult | null {
  const obj = extractJsonObject(reply);
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const title = typeof record.title === 'string' ? clampWords(record.title, MAX_TITLE_WORDS) : '';
  if (!title) return null;
  const state = coerceTabState(record.state);
  const awaitingPrompt =
    state === 'awaiting' && typeof record.awaitingPrompt === 'string'
      ? record.awaitingPrompt.trim()
      : '';
  return {
    title,
    contextLines: asStringArray(record.contextLines, MAX_CONTEXT_LINES),
    currentAction: typeof record.currentAction === 'string' ? record.currentAction.trim() : '',
    state,
    activity: coerceActivity(record.activity),
    ...(awaitingPrompt ? { awaitingPrompt } : {}),
  };
}

/** Parse the writer model's subtitle reply (a JSON object carrying one
 *  sentence), clamped to {@link MAX_SUBTITLE_CHARS}. Returns `''` when the reply
 *  has no usable `subtitle` string. Exported for unit testing. */
export function parseSubtitle(reply: string): string {
  const obj = extractJsonObject(reply);
  if (typeof obj !== 'object' || obj === null) return '';
  const record = obj as Record<string, unknown>;
  return clampChars(record.subtitle, MAX_SUBTITLE_CHARS);
}

// Guardrails below were tuned against an eval of a week of real terminal logs on
// deepseek-v4-flash: name the tool from cmd/status (never invent one), don't read
// the user's draft prompt line as an action, classify the tab into one structured
// `state` (working/awaiting/idle/error) the dashboard colours on, and title the
// work rather than the tool. A finished coding-agent turn (a complete reply
// already printed, input box back to empty) is `idle`, not `working`: the model
// over-eagerly read a long visible reply as "still generating", which the
// activity gate then froze on the card. The engine's idle-decay is the backstop;
// the finished-turn rule below is the fix at the source.
// The dual failure — a MID-turn `[user]` transcript tail misread as awaiting/idle
// because the live spinner is grid-only and the transcript freezes on the user's
// request until the next `Stop` — is forced back to `working` deterministically in
// `buildSummary` (engine.ts); the `[user]`-tail rule below reinforces the card
// content the model writes for it.
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
  'Classify the tab into exactly one state. "working": output is still',
  'progressing — say what it is doing. "awaiting": the program asked a specific',
  'question or shows an interactive menu/prompt that needs an answer — say what',
  'answer it awaits. Reserve "awaiting" for a concrete blocking prompt that halts',
  'progress until answered (e.g. "Overwrite? (y/n)", "Press Enter to continue", a',
  'numbered selection). An agent that has finished and is merely offering',
  'suggestions or asking an open-ended "what would you like to do next?" is idle,',
  'NOT awaiting — it is resting, not blocked. "idle": the work finished or nothing',
  'is pending — say so, and you may add the last meaningful thing it did; an agent',
  'resting at an empty prompt after finishing is idle, not blocked on you. A coding agent (claude,',
  'opencode, pi, codex) that has printed a complete reply and returned to an empty',
  'input box is idle, not working — a long reply already visible in full is',
  'finished output, not work in progress. Call such a tab "working" only when a',
  'live progress indicator is present: a running spinner, an "esc to interrupt" or',
  '"thinking" hint, or text still actively streaming. "error": a command crashed',
  'or a process exited non-zero and is NOT recovering — a recoverable warning is',
  'not an error, it stays "working" or "idle".',
  'The recent output may be a transcript whose messages are tagged [user],',
  '[assistant], or [reasoning]. When the LAST tagged message is [user] — the user',
  'just submitted a request and no [assistant] reply is framed after it — the agent',
  'has received it and is mid-turn: classify "working" and pick the matching',
  'activity, never "awaiting" or "idle". The reply may not have streamed into the',
  'transcript yet, so the absence of a visible progress indicator does not mean it',
  'is resting. The finished-reply-is-idle and "awaiting" judgements apply only when',
  'the last message is [assistant], and "awaiting" still requires that [assistant]',
  'message to end on a concrete blocking question.',
  'Treat informational notices and recoverable warnings as background noise (for',
  'example "workspace not trusted", "N permissions ignored", deprecation or auth',
  'notices): never report them as the current action, a blocker, or an error.',
  'Also classify the finer-grained ACTIVITY — what the operator is doing NOW, by',
  'the task, NOT the tool name. Choose exactly one: "implementing" (writing or',
  'editing code), "designing" (planning or architecting before code is written),',
  '"reviewing" (reading or answering a code review or a diff), "making-pr"',
  '(opening or updating a pull request), "documenting" (writing docs, a README, or',
  'notes), "testing" (running or writing tests), "debugging" (diagnosing a failure',
  'or crash), "researching" (reading or searching to decide what to do),',
  '"awaiting" (blocked on a concrete prompt that needs the operator), or "idle"',
  '(nothing in progress). Judge from the latest output: e.g. a git push + PR URL',
  'or "gh pr create" is making-pr; running a test command is testing; reading a',
  'stack trace and editing is debugging; an empty prompt after a finished reply is',
  'idle. Default to "idle" when unsure.',
  'Reply with ONLY a JSON object, no markdown fence:',
  '{"title": string (<=5 words naming the work, project, or subject the tab is',
  ' about — not the program; e.g. good "Auth refactor", bad "claude". Never derive',
  ' the title from an example, suggestion, greeting, or placeholder the program',
  ' prints on an empty prompt (e.g. a "Try \\"how do I…\\"" hint) — that is not work',
  ' the tab did; when the tab has done no real work yet, title it by its program or',
  ' directory name instead),',
  ' "contextLines": string[] (1-4 short factual lines: what this tab is for and recent progress),',
  ' "currentAction": string (one short line for the state: what is happening now,',
  ' the answer it awaits, or the final/idle state),',
  ' "state": one of "working" | "awaiting" | "idle" | "error" (judged from the latest output),',
  ' "activity": one of "implementing" | "designing" | "reviewing" | "making-pr" |',
  ' "documenting" | "testing" | "debugging" | "researching" | "awaiting" | "idle",',
  ' "awaitingPrompt": string (ONLY when state is "awaiting": the one-line question',
  ' or selection it is blocking on, e.g. "Overwrite file? (y/n)"; omit otherwise)}.',
].join(' ');

const SUBTITLE_SYSTEM_PROMPT = [
  'You write ONE short sentence (at most 140 characters) describing the PURPOSE of',
  'the work in a single terminal tab — the goal, not the command or tool.',
  'You are given the card facts (title, current action, a few context lines, the',
  'activity stage and state) and provenance (the app, the worktree/branch, and any',
  'conception project titles for that branch).',
  'Name what the operator is trying to accomplish and why, weaving in the app and',
  'project when they add context. Do not name the program (claude, opencode, git).',
  'Do not invent facts beyond what you are given. Prefer the project title as the',
  'goal when one is present.',
  'Reply with ONLY a JSON object, no markdown fence:',
  '{"subtitle": string (one sentence, <=140 chars, no trailing tool name)}.',
].join(' ');

/** Assemble the per-tab user prompt. Every field that carries captured terminal
 *  content — the command, cwd, the prior summary, and the recent output — is run
 *  through `redactSecrets` here, the single chokepoint before the text is POSTed
 *  to the LLM, so a secret printed in a watched tab never leaves the machine in
 *  clear text. Locally stored/displayed data (titles, state.json) is untouched.
 *  Exported for unit testing. */
export function buildTabUserPrompt(input: TabInput, maxChars: number = MAX_RECENT_CHARS): string {
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
  lines.push(redactSecrets(input.recentText.slice(-maxChars)));
  lines.push('"""');
  return lines.join('\n');
}

/** Assemble the per-tab subtitle user prompt from the card facts + provenance.
 *  Every captured-content field (title, action, context, plus the provenance
 *  names) is run through `redactSecrets` here — the single chokepoint before the
 *  text is POSTed — so nothing secret leaves the machine in clear text. The
 *  activity/state enums are model-derived and carry no captured content.
 *  Exported for unit testing. */
export function buildSubtitleUserPrompt(facts: SubtitleInput, provenance: TabProvenance): string {
  const lines: string[] = [];
  lines.push(`Title: ${redactSecrets(facts.title)}`);
  lines.push(`Activity: ${facts.activity} (state: ${facts.state})`);
  if (facts.currentAction) lines.push(`Current action: ${redactSecrets(facts.currentAction)}`);
  for (const line of facts.contextLines.slice(0, MAX_CONTEXT_LINES)) {
    lines.push(`Context: ${redactSecrets(line)}`);
  }
  if (provenance.app) lines.push(`App: ${redactSecrets(provenance.app)}`);
  if (provenance.worktree) lines.push(`Worktree/branch: ${redactSecrets(provenance.worktree)}`);
  const projectTitles = (provenance.projects ?? []).map((p) => p.title).filter(Boolean);
  if (projectTitles.length > 0) {
    lines.push(`Project(s): ${projectTitles.map((t) => redactSecrets(t)).join('; ')}`);
  }
  return lines.join('\n');
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

/** A single completion request. `disableReasoning` sends DeepSeek's
 *  `thinking: {type: "disabled"}` switch, which zeroes the model's hidden
 *  reasoning (~3–5× faster, no quality loss on the mechanical card extraction —
 *  validated in the 2026-06-29-dashboard-summarizer-revamp experiment). */
interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  disableReasoning: boolean;
  maxTokens: number;
}

/** Build the OpenAI-compatible chat-completions request body. Pure + exported
 *  so the reasoning switch and message shape are unit-testable without a network
 *  call. `temperature: 0` keeps summaries stable across cycles. */
export function buildCompletionBody(request: CompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: 0,
    max_tokens: request.maxTokens,
  };
  // DeepSeek-format reasoning kill switch. pi never emits this for v4 models
  // (its model def gates it out), which is why the dashboard POSTs directly.
  if (request.disableReasoning) body.thinking = { type: 'disabled' };
  return body;
}

/**
 * Run a single tool-free completion by POSTing directly to the configured
 * OpenAI-compatible `/chat/completions` endpoint. Replaces the former pi SDK
 * path: the summarizer makes one stateless, tool-free call, so pi's session /
 * registry / discovery machinery was pure overhead — and pi cannot emit the
 * `thinking:{type:"disabled"}` reasoning switch for DeepSeek v4 models, which is
 * the dashboard's main latency lever.
 *
 * `config.baseUrl` (e.g. an opencode-go / Zen gateway or a self-hosted proxy)
 * overrides the endpoint; with none set it falls back to DeepSeek's own. A named
 * `User-Agent` is always sent — some gateways Cloudflare-403 the default one.
 *
 * @throws when there is no key, the endpoint errors, or the call times out.
 */
async function runCompletion(config: DashboardConfig, request: CompletionRequest): Promise<string> {
  if (!config.apiKey) throw new Error('dashboard: no API key configured');
  // Electron 33's global fetch (undici) needs this shim before its first call.
  ensureUndiciElectronShim();
  const base = (config.baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE).replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  // AbortController frees the socket if the deadline wins; withTimeout bounds the
  // await so a black-holed connection can't wedge the engine's single-flight guard.
  const controller = new AbortController();
  const fetchAndParse = fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': DASHBOARD_USER_AGENT,
    },
    body: JSON.stringify(buildCompletionBody(request)),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(
        `dashboard: ${request.model} HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  });
  try {
    return await withTimeout(fetchAndParse, COMPLETION_TIMEOUT_MS, 'dashboard: completion');
  } catch (err) {
    controller.abort();
    throw err;
  }
}

/** Summarize one terminal tab with the cheap "card" model (reasoning off by
 *  default) over a wide window. Returns null when the model reply can't be parsed
 *  or the call fails — the engine then keeps the prior summary. */
export async function summarizeTab(
  config: DashboardConfig,
  input: TabInput,
): Promise<TabSummaryResult | null> {
  try {
    const reply = await runCompletion(config, {
      model: config.model,
      system: TAB_SYSTEM_PROMPT,
      user: buildTabUserPrompt(input, config.cardInputChars),
      disableReasoning: !config.cardReasoning,
      // Reasoning needs headroom (it counts against max_tokens); a non-reasoning
      // card emits only the small JSON object.
      maxTokens: config.cardReasoning ? 4000 : 1500,
    });
    return parseTabSummary(reply);
  } catch (err) {
    lastError = (err as Error).message;
    process.stderr.write(`condash dashboard: summarizeTab failed: ${(err as Error).message}\n`);
    return null;
  }
}

/** Compose the per-tab subtitle from the card facts + provenance with the
 *  richer "writer" model (reasoning on by default). Returns `''` when the call
 *  fails or the reply has no usable sentence — the engine then leaves the tab's
 *  subtitle blank. */
export async function writeSubtitle(
  config: DashboardConfig,
  facts: SubtitleInput,
  provenance: TabProvenance,
): Promise<string> {
  try {
    const reply = await runCompletion(config, {
      model: config.writerModel,
      system: SUBTITLE_SYSTEM_PROMPT,
      user: buildSubtitleUserPrompt(facts, provenance),
      disableReasoning: !config.writerReasoning,
      // A subtitle is one short sentence; reasoning still wants headroom (it
      // counts against max_tokens) but far less than the old cross-tab narrative.
      maxTokens: config.writerReasoning ? 2000 : 500,
    });
    return parseSubtitle(reply);
  } catch (err) {
    lastError = (err as Error).message;
    process.stderr.write(`condash dashboard: writeSubtitle failed: ${(err as Error).message}\n`);
    return '';
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
    const reply = await runCompletion(config, {
      model: config.model,
      system: 'You are a connection test. Reply with the single word OK.',
      user: 'Reply with OK.',
      disableReasoning: true,
      maxTokens: 200,
    });
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
