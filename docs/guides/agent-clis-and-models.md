---
title: Agent CLIs and model providers · condash guide
description: Pair any agent CLI (Claude Code, Kimi, OpenCode, Aider) with any model provider (Anthropic, Moonshot/Kimi) using small wrapper scripts, run them as condash terminal launchers, and inject a global AGENTS.md into Kimi.
---

# Agent CLIs and model providers

> **Audience.** Daily user who runs more than one coding agent — or one agent against more than one model provider — and wants each as a one-click launcher.

**When to read this.** You want `claude` to talk to a non-Anthropic model, you juggle several agent CLIs, or you want Kimi to read a global instructions file the way Claude Code reads `~/.claude/CLAUDE.md`.

!!! note "These are just examples"
    condash launches whatever command you point a terminal launcher at — it has no opinion about which agent or model you run. The wrapper scripts on this page are **illustrative examples** of one tidy way to pin an agent CLI to a model provider. They are not a built-in feature and not an exhaustive list. Swap in whatever CLIs, providers, and models you actually use.

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

Claude Code automatically reads a global instructions file at `~/.claude/CLAUDE.md`. Kimi has no global instructions file by default, but you get the equivalent with a **custom agent file** that you pass on launch:

```yaml
# ~/.kimi/global-agent.yaml
version: 1
agent:
  extend: default
  system_prompt_args:
    ROLE_ADDITIONAL: |
      # Global Instructions
      <your global rules here — the equivalent of a global AGENTS.md / CLAUDE.md:
       communication style, git conventions, safety rules, …>
```

- **`agent.extend: default`** starts from Kimi's built-in default agent and layers your additions on top, rather than replacing the agent wholesale.
- **`system_prompt_args.ROLE_ADDITIONAL`** is spliced into the agent's system prompt. This block is where your global rules live — paste in the same content you would put in a global `AGENTS.md` / `CLAUDE.md`.
- **Launch with the flag**: `kimi --agent-file ~/.kimi/global-agent.yaml`. Plain `kimi` does **not** auto-load this file — which is exactly why the `kimi-kimi` wrapper above passes `--agent-file`. Wrapping it means you never forget the flag.

!!! tip "Generate it instead of hand-editing"
    If you keep one source of truth for your global agent rules and compile it to several targets, condash can write the per-target instruction files for you (Claude's `CLAUDE.md`, Kimi's `AGENTS.md`/agent file, OpenCode's `AGENTS.md`). See the [`condash skills install` reference](../reference/cli.md#skills) and [Management skill](../reference/skill.md).

## Add a new cell

1. **Pick the cell** — which agent CLI, which provider + model.
2. **Identify the binding style** the CLI supports (above): provider env vars, an auth store, a config/agent file, or OpenAI-compatible env.
3. **Find the provider's compatibility surface** — Anthropic-compatible, OpenAI-compatible, or native. This decides the env-var family or `--model` namespace.
4. **Create `~/bin/<agent-cli>-<provider>`** — `#!/usr/bin/env bash`, `set -euo pipefail`, the wiring for that style, then `exec <cli> "$@"`.
5. **Secrets & permissions** — if a key is inline, `chmod 700` the file and never commit it. Prefer the CLI's own auth store (style 2) when it has one.
6. **Smoke test** — launch it, confirm the model name in the CLI's status line, run one trivial tool call.

## Run a wrapper as a condash launcher

condash's embedded terminal has a **spawn dropdown** populated from `terminal.launchers`. Register each wrapper there to launch it in one click:

```json
{
  "terminal": {
    "launchers": [
      { "label": "Claude · Claude", "command": "claude",        "title": "claude" },
      { "label": "Claude · Kimi",   "command": "claude-kimi",   "title": "claude-kimi" },
      { "label": "Kimi · Kimi",     "command": "kimi-kimi",     "title": "kimi-kimi" },
      { "label": "OpenCode · Kimi", "command": "opencode-kimi", "title": "opencode-kimi" }
    ]
  }
}
```

Each entry's `command` must resolve on the spawn shell's `PATH` (so keep your wrapper directory, e.g. `~/bin`, on `PATH`). The `title` becomes the pinned tab label. See [Use the embedded terminal](terminal.md#editing-shortcuts) for editing launchers in the Settings modal, and [Config files](../reference/config.md) for the full `terminal.launchers` schema.

## See also

- [Use the embedded terminal](terminal.md) — the spawn dropdown, tabs, and launchers that run these wrappers.
- [Config files](../reference/config.md) — the `terminal.launchers` schema.
- [CLI reference](../reference/cli.md#skills) — `condash skills install` and the `--user` scope.
