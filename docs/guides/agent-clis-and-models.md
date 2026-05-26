---
title: Agent CLIs and model providers · condash guide
description: Pair any agent CLI (Claude Code, Kimi, OpenCode) with any model provider (Anthropic, DeepSeek, Moonshot/Kimi) as a condash agent, launched in one click from the terminal spawn dropdown.
---

# Agent CLIs and model providers

> **Audience.** Daily user who runs more than one coding agent — or one agent against more than one model provider — and wants each as a one-click agent.

**When to read this.** You want `claude` to talk to a non-Anthropic model, you juggle several agent CLIs, or you want Kimi to read a global instructions file the way Claude Code reads `~/.claude/CLAUDE.md`.

!!! tip "Define agents in the Agents pane"
    condash's **Agents** pane (right-edge strip → **Agents**, or `Ctrl+Shift+A`) is the built-in way to do all of this: an *agent* is a harness (claude / kimi-cli / opencode) + a model + an API token, with a free-form display **name** and a stable lowercase-kebab **slug** (its filename + identity). condash builds the harness's environment (claude's `ANTHROPIC_*`, opencode's `--model`, kimi-cli's `--agent-file`) for you and injects it when you launch the agent from the terminal spawn dropdown. The environment-variable details below are the **reference** for what each harness needs — you no longer hand-write wrapper scripts; you fill in a form. Tokens live in the gitignored `<conception>/agents/.env`. A fourth harness, **`agentsconf`**, does the opposite — it just runs a wrapper binary you name and lets that binary own all of the config (see [Run a wrapper binary directly](#run-a-wrapper-binary-directly-the-agentsconf-harness)).

## Two dimensions

Every coding session is one cell of a 2-D matrix:

- **Agent CLI** — the local tool that drives the loop (reads files, runs tools, edits code). For example `claude` (Claude Code), `kimi` (Kimi CLI), `opencode` (OpenCode), `aider` (Aider).
- **Model provider** — the API endpoint, credentials, and model name the CLI talks to. For example **Anthropic** (Claude models) and **Moonshot** (Kimi models, served from `api.kimi.com` / `api.moonshot.ai`).

The two are independent: the same agent CLI can run against different providers, and the same provider can serve different agent CLIs. A small wrapper script pins one specific cell so you can launch it by name.

### The matrix, by example

| Wrapper        | Agent CLI   | Provider / endpoint              | Model              | Binding style          |
|----------------|-------------|----------------------------------|--------------------|------------------------|
| _(none)_       | Claude Code | Anthropic (default)              | Claude             | native                 |
| `claude-kimi`  | Claude Code | Moonshot `api.kimi.com/coding/`  | `kimi-k2.6`        | env-var remap          |
| `kimi-kimi`    | Kimi CLI    | Moonshot (native)                | Kimi (CLI default) | native + agent file    |
| `opencode-kimi`| OpenCode    | Moonshot via a named provider    | `kimi-k2-thinking` | auth store + `--model` |
| `aider-kimi`   | Aider       | Moonshot `api.moonshot.ai/v1`    | your choice        | OpenAI-compatible env  |

## A naming convention for wrappers

Keep the wrappers in one directory on your `PATH` (e.g. `~/bin`) and name each one **`<agent-cli>-<provider>`**:

- the first token is the agent CLI binary it launches (`claude`, `kimi`, `opencode`, `aider`);
- the second token is a short provider tag (`kimi` = the Moonshot/Kimi backend).

The **default cell needs no wrapper**: plain `claude` is Claude Code on its native Anthropic provider — it "just works". A wrapper exists only when a cell needs non-default wiring (a different provider, an agent file, or a model flag).

## Example wrappers

### Plain `claude` — Claude Code on Anthropic (no wrapper)

The baseline. No environment overrides; Claude Code uses its built-in Anthropic endpoint and your logged-in account. Everything below is a deviation from this.

### `claude-kimi` — Claude Code on a different provider (env-var remap)

The instructive case. Claude Code is built to talk to Anthropic; this wrapper **remaps it wholesale via environment variables** before `exec claude`. Because the key is inline, `chmod 700` the file.

```bash
#!/usr/bin/env bash
# claude-kimi — run Claude Code against an Anthropic-compatible Kimi endpoint.
set -euo pipefail

# --- Endpoint & auth ---
export ANTHROPIC_BASE_URL="https://api.kimi.com/coding/"
# bearer -> Authorization: Bearer <key>;  apikey -> x-api-key: <key>. Switch on 401.
export ANTHROPIC_AUTH_TOKEN="sk-…"        # or ANTHROPIC_API_KEY for the apikey style

# --- Models: set ALL of them to the target model ---
# Claude Code resolves the literal aliases haiku/sonnet/opus and runs a smaller
# model for background work (titles, compaction, the auto-mode classifier,
# subagents). Point every one at the provider's model so nothing falls back to
# an Anthropic name the endpoint won't serve.
export ANTHROPIC_MODEL="kimi-k2.6"
export ANTHROPIC_SMALL_FAST_MODEL="kimi-k2.6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="kimi-k2.6"
export ANTHROPIC_DEFAULT_SONNET_MODEL="kimi-k2.6"
export ANTHROPIC_DEFAULT_OPUS_MODEL="kimi-k2.6"
export CLAUDE_CODE_SUBAGENT_MODEL="kimi-k2.6"

# --- Context window (drives the "% context left" display + compaction) ---
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144   # Kimi-k2.6 = 256K

# --- Reasoning effort (optional) ---
# Providers that map Claude Code's /effort onto their own reasoning budget
# (e.g. DeepSeek) honour this; omit it to let the live session's /effort drive.
export CLAUDE_CODE_EFFORT_LEVEL=max

# --- Turn off Anthropic-only features the endpoint may not honour ---
export DISABLE_PROMPT_CACHING=1                 # flip off if caching is confirmed
export CLAUDE_CODE_DISABLE_1M_CONTEXT=1
export CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL=1   # hides the Anthropic-SDK skill

# Defensive: no cloud-provider routing intercepts the call.
unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX \
      CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE

exec claude "$@"
```

The single most useful detail is the **model block**: it is not enough to set the main model. Claude Code resolves `haiku`/`sonnet`/`opus` aliases and uses a small/fast model for background tasks, so every alias must point at a model the new endpoint actually serves — otherwise some background call silently 404s on an Anthropic model name.

### `kimi-kimi` — Kimi CLI on Kimi (native + agent file)

Trivial, because Kimi's native provider is already Moonshot/Kimi — no remap:

```bash
#!/usr/bin/env bash
set -euo pipefail
kimi --agent-file ~/.kimi/global-agent.yaml
```

The only argument is the **agent file** — Kimi's equivalent of a global instructions file. See [Inject a global AGENTS.md into Kimi](#inject-a-global-agentsmd-into-kimi) below.

### `opencode-kimi` — OpenCode on Kimi (auth store + `--model`)

```bash
#!/usr/bin/env bash
set -euo pipefail
# Drop external skill roots so only OpenCode's own skills load.
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
opencode --model kimi-for-coding/kimi-k2-thinking
```

Unlike `claude-kimi`, the credential is **not** in the wrapper. The model string is `<provider>/<model>`; the `kimi-for-coding` provider is registered once with `opencode auth login` and stored in OpenCode's auth file. The wrapper just selects the model and launches. (OpenCode is often installed as a self-contained binary, e.g. under `~/.opencode/bin` — make sure that directory is on your `PATH`.)

To control reasoning per agent, condash's opencode agent editor shows a single **options table**: a **default** row (the default model + `reasoningEffort` (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`), `textVerbosity` (`low`/`medium`/`high`), `reasoningSummary` (`auto`/…)) applied to every agent, plus **per-agent rows** that override the **model** and/or those options (e.g. `plan` on `kimi-for-coding/kimi-k2-thinking` at `high`, `build` on the default `deepseek` model at `low`). condash inlines the table as plain options: the default row → the default model's base `options`; each per-agent row → `agent.<name>.options` (+ `agent.<name>.model`). Each agent's effort is **applied to its requests** (verified on the wire). Providers that support a reasoning budget (e.g. DeepSeek) map `reasoningEffort` onto their own setting; leave effort blank to use the model default. Note: a model belongs to the **agent** (`agent.<name>.model`). (opencode's status footer shows the live model-variant selection, not the per-agent configured effort — an opencode display detail, independent of this config.)

The agent name in a per-agent row is **free text**, and each row has a **primary** toggle. Type a custom name and leave the toggle on to define a *new* switchable agent (opencode's Tab cycles primaries) beyond the built-in `build`/`plan` — condash emits `agent.<name>.mode = "primary"`. The built-in agents are shown with their fixed mode and a disabled toggle: `build` and `plan` are primary (checked); `general`, `explore`, and `scout` are subagents (unchecked). condash never writes a `mode` for a built-in name, so overriding one only changes its model/options. A custom primary agent is just a switchable model/effort variant — it uses the base prompt and skills, so no extra prompt is needed.

### `aider-kimi` — Aider via an OpenAI-compatible endpoint

Aider speaks the OpenAI API shape, so you point it at any OpenAI-compatible endpoint with two env vars:

```bash
#!/usr/bin/env bash
set -euo pipefail
export OPENAI_API_BASE="https://api.moonshot.ai/v1"
export OPENAI_API_KEY="sk-…"
exec aider --model <provider-model-name> "$@"
```

Note the endpoint: Aider uses Moonshot's **OpenAI-compatible** surface (`api.moonshot.ai/v1`), which is distinct from the **Anthropic-compatible** surface (`api.kimi.com/coding/`) that `claude-kimi` targets — same vendor, different compatibility layer. Pick the surface that matches your CLI's native API shape.

## The four binding styles

How you point a CLI at a non-native provider depends on how that CLI was built. In rough order of effort:

1. **Env-var remap** (`claude-kimi`) — the CLI assumes one provider; you override base URL, auth, every model alias, and feature toggles via environment. Most wiring, most fragile, because provider-specific features must be turned off by hand.
2. **Auth store + model flag** (`opencode-kimi`) — register the provider once (`auth login`), then choose it per run with `--model provider/model`. The credential lives in the CLI's store, not the wrapper.
3. **Native** (`kimi-kimi`, plain `claude`) — the CLI's own default provider; the wrapper adds at most a config/agent file.
4. **OpenAI-compatible env** (`aider-kimi`) — `OPENAI_API_BASE` + `OPENAI_API_KEY` point an OpenAI-client CLI at any compatible endpoint.

## Inject a global AGENTS.md into Kimi

Claude Code automatically reads `~/.claude/CLAUDE.md`; Kimi has no global instructions file by default. condash bridges this for **kimi-cli agents**: the kimi agent's **Instructions file** field points at a plain markdown file (default **`~/.kimi/AGENTS.md`**), and when you launch a kimi agent condash reads that file and wraps it into a *transient* `--agent-file` at spawn — so the instructions are always current and there's no YAML to hand-maintain. condash does not write that file itself; supply it yourself (or have your agent-config tooling lay it down).

The agent file condash generates at launch has this shape:

```yaml
version: 1
agent:
  extend: default
  system_prompt_args:
    ROLE_ADDITIONAL: |
      # Global Instructions
      <contents of ~/.kimi/AGENTS.md>
```

- **`agent.extend: default`** starts from Kimi's built-in default agent and layers your additions on top.
- **`system_prompt_args.ROLE_ADDITIONAL`** is spliced into the agent's system prompt — the equivalent of a global `AGENTS.md` / `CLAUDE.md`.
- Plain `kimi` does **not** auto-load instructions; condash always passes the generated `--agent-file`. The kimi agent's **Instructions file** field (default `~/.kimi/AGENTS.md`) selects the source.

If you run kimi outside condash, write a YAML of the shape above yourself and pass it as `--agent-file`.

## Add a new cell

1. **Pick the cell** — which agent CLI, which provider + model.
2. **Identify the binding style** the CLI supports (above): provider env vars, an auth store, a config/agent file, or OpenAI-compatible env.
3. **Find the provider's compatibility surface** — Anthropic-compatible, OpenAI-compatible, or native. This decides the env-var family or `--model` namespace.
4. **Create `~/bin/<agent-cli>-<provider>`** — `#!/usr/bin/env bash`, `set -euo pipefail`, the wiring for that style, then `exec <cli> "$@"`.
5. **Secrets & permissions** — if a key is inline, `chmod 700` the file and never commit it. Prefer the CLI's own auth store (style 2) when it has one.
6. **Smoke test** — launch it, confirm the model name in the CLI's status line, run one trivial tool call.

## Run a wrapper binary directly (the `agentsconf` harness)

The `claude` / `kimi-cli` / `opencode` harnesses **reproduce** a wrapper's wiring in-process — condash builds the `ANTHROPIC_*` env, the `--model` flag, the agent file. The **`agentsconf`** harness is the inverse: it just runs a wrapper binary you name and treats it as a black box. The binary (e.g. one of the `~/bin/<agent-cli>-<provider>` wrappers above, or any launcher shipped by your agent-config repo) owns the model, env, instructions, and skills; condash sets nothing else and resolves no token.

Its only config is the **binary** name. condash launches it two ways:

- **terminal** (Launch button, spawn dropdown) → `<binary>`
- **task** (a Tasks-pane run with a prompt) → `<binary> --run "<PROMPT>"`

Use it when the wrapper already exists and you'd rather not duplicate its configuration in condash — or when the binary is the canonical owner of agent config and condash should stay a thin launcher. Any binary used this way must accept `--run "<prompt>"` for task mode and run interactively with no arguments for terminal mode.

!!! note "Not the retired `terminal.launchers`"
    This is a first-class **harness** (an agent stored at `agents/<slug>.json`), not the old per-machine `terminal.launchers` list that was retired in 3.25 (see the note at the end of the next section). The difference: an agentsconf agent is conception-scoped, slug-identified, editable, and launchable like any other agent.

## Define it as a condash agent

Open the **Agents** pane (right-edge strip → **Agents**, or `Ctrl+Shift+A`) and click **+ New agent**:

1. **Harness** — `claude`, `kimi-cli`, `opencode`, or `agentsconf`.
2. **Name + slug** — **Name** is a free-form display label (spaces and any case fine, e.g. `DeepSeek Auto`). **Slug** is the lowercase-kebab identity (the filename); it auto-fills from the name (as `<harness-label>-<slugified-name>`, e.g. `opencode-deepseek-auto`) until you hand-edit it. The slug stays editable after creation — changing it renames the agent file (`agents/<slug>.json`) and cascades to repoint every task that referenced the old slug.
3. **Config** — depends on the harness:
   - **claude** — left at its defaults (empty Base URL, no token) condash runs bare `claude` against your own Anthropic login. To remap to an alt-provider, open "Advanced claude config" and fill the **Base URL**, **Auth style**, model + alias fields, effort level, and `DISABLE_*` toggles by hand (see the endpoint + model table above).
   - **opencode** — fill the **per-agent options table**: the `default` row sets the default model + reasoning effort / verbosity / summary for every agent, and each added row overrides one agent's model and/or options (e.g. plan-on-one-model, build-on-another), or — with a custom name and the **primary** toggle on — defines a new switchable agent (`agent.<name>.mode = "primary"`) beyond `build`/`plan`; plus an "Extra config (JSON)" escape hatch. condash translates the table into `OPENCODE_CONFIG_CONTENT` — the default row → the default model's base `options`, each per-agent row → `agent.<name>.options` (+ `agent.<name>.model`, + `mode` for a custom primary) — so each agent's effort reaches its requests. No `opencode.json` needed.
   - **kimi-cli** — set the `--agent-file`, optional `--model`, thinking mode (`--thinking` / `--no-thinking`), `--plan`, and an inline `--config` (TOML/JSON) escape hatch.
   - **agentsconf** — fill in a single **Binary** (on `$PATH`, e.g. `claude-deepseek-auto`). No token, model, or env fields: the binary owns all of that. condash runs `<binary>` for a terminal and `<binary> --run "PROMPT"` for a task.
4. **Token env var** — the name of the variable holding the API key (e.g. `DEEPSEEK_API_KEY`). Set the value in **Edit tokens (agents/.env)**, an in-app editor for the gitignored `<conception>/agents/.env`. (Not shown for the `agentsconf` harness, whose binary owns its own auth.)

The **Will launch** panel previews the exact command + environment as you edit (token shown as a `$NAME` reference, never the value). The agent is saved as `<conception>/agents/<slug>.json` and appears in the terminal **spawn dropdown** (by its display name) and as a binding target for project / new-project actions. Each agent row shows its launch command and a single **Launch** button (opens a tab running it with the environment injected); **click the row** to open the edit view, which carries **Save** / **Cancel** and a confirmed **Delete**.

There is no wrapper script and nothing on `PATH` to maintain — condash builds the harness environment in-process. (condash ≤ 3.25 used `~/bin` wrapper scripts registered as `terminal.launchers`; that approach is retired.)

## See also

- [Use the embedded terminal](terminal.md) — the spawn dropdown and tabs that run these agents.
- [Config files](../reference/config.md#agents) — agent storage (`<conception>/agents/`) and the `agents/.env` tokens file.
- [CLI reference](../reference/cli.md#skills) — `condash skills install`.
