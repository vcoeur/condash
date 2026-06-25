import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardConfig, DashboardEvent, TabSummary } from '../../shared/types';

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

const TAB_SYSTEM_PROMPT = [
  'You summarize a single terminal tab for a developer dashboard.',
  'You are given the tab command/cwd, the prior summary (if any), and the most',
  'recent terminal output. Reply with ONLY a JSON object, no markdown fence:',
  '{"title": string (<=5 words naming what the tab is doing),',
  ' "contextLines": string[] (1-4 short lines: what this tab is for and recent progress),',
  ' "currentAction": string (one short line: what is happening right now, or the',
  ' final state if the command finished/idle)}.',
].join(' ');

const OVERVIEW_SYSTEM_PROMPT = [
  'You summarize what a developer is doing across several terminal tabs.',
  'You are given each tab id and its current summary. Reply with ONLY a JSON',
  'object, no markdown fence:',
  '{"overview": string[] (2-5 short lines describing the overall current activity,',
  ' referencing tabs by title when useful),',
  ' "events": string[] (0-3 short notable cross-tab events worth remembering, else [])}.',
].join(' ');

function buildTabUserPrompt(input: TabInput): string {
  const lines: string[] = [];
  lines.push(`Tab command: ${input.cmd ?? '(shell)'}`);
  if (input.cwd) lines.push(`Working directory: ${input.cwd}`);
  if (input.prior) {
    lines.push('');
    lines.push('Prior summary:');
    lines.push(
      JSON.stringify({
        title: input.prior.title,
        contextLines: input.prior.contextLines,
        currentAction: input.prior.currentAction,
      }),
    );
  }
  lines.push('');
  lines.push('Most recent terminal output:');
  lines.push('"""');
  lines.push(input.recentText.slice(-MAX_RECENT_CHARS));
  lines.push('"""');
  return lines.join('\n');
}

function buildOverviewUserPrompt(tabs: TabSummary[]): string {
  const lines = ['Open tabs and their current summaries:', ''];
  for (const tab of tabs) {
    lines.push(`- [${tab.sid}] ${tab.title}: ${tab.currentAction}`);
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
 * Run a single tool-free completion through the pi coding-agent SDK against the
 * configured provider/model. Fully isolated: in-memory auth + model registry +
 * session, discovery (skills, extensions, context files like AGENTS.md) all
 * disabled, no tools — the model sees only the system + user prompt we pass.
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
  const { AuthStorage, ModelRegistry, SessionManager, DefaultResourceLoader, createAgentSession } =
    await import('@earendil-works/pi-coding-agent');

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(config.provider, config.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
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
    await session.prompt(userPrompt);
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
    process.stderr.write(
      `condash dashboard: synthesizeOverview failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

/** Build a dashboard event from a one-line description, stamped now. */
export function makeEvent(text: string, at: number): DashboardEvent {
  return { at, text };
}
