---
title: The Dashboard (tab summaries) · condash guide
description: Turn a wall of terminal tabs into a card per tab — what each one is doing, which is waiting on you, and where its work lives. Opt-in, LLM-backed, off by default.
---

# The Dashboard (tab summaries)

> **Audience.** Daily user running several agent tabs at once.

**When to read this.** You have eight terminal tabs open, three of them agents, and reading the tab strip tells you nothing about which one needs you.

The Dashboard summarises every open terminal tab into a card: a few-word title, what stage the work is at, where it lives, and whether it is waiting on you. It is **off by default** and needs an API key — see [Turning it on](#turning-it-on).

## Opening it

The Dashboard lives in the **bottom band**, next to Terminal — it is not a right-slot working surface, so it never displaces Code or Knowledge.

- The left terminal tab strip's **first entry** is a fixed **Dashboard** pseudo-tab. It cannot be renamed, closed, or dragged. Selecting it swaps the bottom band to the Dashboard; selecting any real terminal tab switches straight back; clicking it while it is already active closes the pane.

It is always present, even with summarisation off — the body then explains how to enable it.

## The status line

One thin line above the cards:

| Element | Meaning |
|---|---|
| Power dot + label | `Off`, `On · no key`, `On · backoff` (the engine is backing off after repeated failures), or `On`. |
| Tallies | Total open tabs, then counts by state: **working**, **awaiting**, **idle** — plus **error** when any tab is in it. |
| `updated HH:MM` | When the last summarisation cycle landed, or `not yet run`. |
| `config` | Hover or focus it to reveal the live summariser config: provider, the card and writer models with their reasoning flags, the endpoint, the interval, the activity gate, skip-idle, and whether an API key is **set** or **missing**. The key itself is never shown. |

A failed cycle would otherwise be a silent no-op — tab titles simply stop updating — so the last error is surfaced in a banner under the line.

## The cards

One card per **open** tab, in the same order as the tab strip. The whole card is a link: click it to jump to that terminal tab.

- **State dot** — working / awaiting you / idle / error.
- **Age** — time since this card's last refresh. A card being recomputed right now shows a small pulsing marker.
- **Update** — queue a re-summarisation of just this tab, bypassing its interval/activity gate and scheduled backoff. Shown only when the engine can actually run (enabled, with a key), and disabled while that card is already recomputing. Repeated requests for a queued/running tab share that job; they do not create a follow-up refresh.
- **Title + activity pill** — a few-word title plus the work stage: Implementing, Designing, Reviewing, Making PR, Documenting, Testing, Debugging, Researching, Awaiting, Idle.
- **Breadcrumb** — `#app › wt:branch › project`, only the segments that exist. Each is clickable: the app and worktree crumbs open their directory, the project crumb opens its README. When several projects match, the first is shown with a `+N` carrying the rest in its tooltip.
- **Subtitle** — one sentence of context: what this work is and why.
- **Awaiting callout** — when a tab is blocked on you, its blocking question is rendered as a tinted callout so it pulls the eye.
- **Recent actions** — up to four events, most recent first, with relative timestamps.

A tab with no summary yet is never hidden. It falls back to a card drawn from its command and cwd, with the engine's next-attempt hint (`in 45s`, `soon`, `pending`) in the age slot and *"Waiting for first agent output"* as its subtitle.

Each tab has its own timer, but automatic and manual refreshes share **three logical full-summary jobs** at most. A slot covers the card model, local provenance, optional writer model, live state update and ordered persistence. Queued tabs do not show the active pulsing marker. This is not a physical HTTP/socket/remote-execution limit: a timed-out underlying operation may outlive its logical job, and Settings' connection test is outside this count.

Automatic work is FIFO by first eligible enqueue; manual work is FIFO by first request or promotion. While automatic work waits, at most two consecutive manual jobs start before one automatic job. Running work is never preempted. Larger cohorts take more waves to refresh; the policy is a resource budget, not a latency guarantee.

Closing a tab or switching conceptions skips its queued work and unsent later phases. An already-sent phase settles under the existing timeout; stale results, errors and cache changes are discarded. Observation ticks still prune closed tabs and decay quiet cards while jobs/backoff are pending. Both kinds of refresh capture output and advance the clock/byte baseline **at admission**, including null/failed attempts, so output arriving during a request remains eligible for a later refresh.

Scheduled failures back off once per captured batch (30 seconds, doubling to a five-minute ceiling), not once per tab. Manual-only outcomes do not change that backoff. The error banner keeps the latest owned failed admission: a successful scheduled batch clears older scheduled errors; a successful manual refresh clears only its tab's older manual error. State updates merge into the current roster/cards and push before saving. Saves run in order across conception switches; stale pending save intents are skipped and failures are best-effort, not model failures.

The writer cache retains **256 entries**, evicts the least recently used on insertion, promotes hits, has **no TTL**, and clears on conception switches. Every attempt still runs the card model. Eviction can add writer calls: cycling 257 distinct keys three times produces 771 writer calls rather than 257 with unbounded retention (514 extra calls). This bounds entries, not bytes, heap or cost. Existing keys omit the endpoint and can collide across delimiter boundaries; successful empty/garbled writer replies remain cached until eviction/clear, and simultaneous identical misses can still issue separate requests. The retention policy does not promise semantic freshness or change those existing behaviors.

## Turning it on

Everything lives under the **`dashboard`** key in the **per-machine** `settings.json` — a personal setting. Edit it through **Settings → Dashboard** (under *Personal · this machine*), or by hand.

The API key is a secret: it **must** live in the per-machine global file and never in a conception's `.condash/settings.json`, which is a versioned tree. The schema enforces that — `dashboard` is a global-only key and a conception file carrying it is rejected.

```json
{
  "dashboard": {
    "enabled": true,
    "apiKey": "sk-…"
  }
}
```

That is the minimum. The rest has defaults:

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Master switch. Off means nothing runs and no data leaves the machine. |
| `provider` | `deepseek` | The only provider for now; an enum so others can be added. |
| `apiKey` | — | Falls back to the `DEEPSEEK_API_KEY` environment variable. |
| `baseUrl` | provider default | Any OpenAI-compatible endpoint. Falls back to `DEEPSEEK_BASE_URL`. Blank uses the provider's own. |
| `model` | `deepseek-v4-flash` | The cheap "card" tier that extracts facts from raw tab output. |
| `writerModel` | `deepseek-v4-pro` | The richer tier that composes the published title + subtitle. |
| `cardReasoning` | `false` | Reasoning on the card tier. |
| `writerReasoning` | `false` | Reasoning on the writer tier. |
| `cardInputChars` | `16000` | How much recent tab output the card model sees. |
| `intervalSec` | `120` | Summarisation cadence, clamped to 30–300. |
| `gateOnActivity` | `true` | Skip a **due tab's** refresh when that tab produced no new output since its last summary. Per tab, not per cycle — one busy tab among nine quiet ones still gets summarised. |
| `skipIdle` | `true` | The narrower backstop **under** `gateOnActivity`: it applies only when the gate is **off**, and only to a due tab whose last card already read `idle` and whose byte count hasn't moved. |
| `historyLimit` | `20` | Retained events per tab and globally. |

Full per-key detail: [Config files → Dashboard](../reference/config.md#dashboard).

## What leaves your machine

With `enabled: false` — nothing. Nothing runs, and no request is made.

With it on, each cycle sends **recent terminal output** (up to `cardInputChars` per tab, plus the derived facts) to the configured endpoint. Every captured field is run through the same secret redactor as `condash logs --redact` first — one chokepoint before the POST, turning provider key prefixes, bearer tokens, JWTs, secret-named assignments, and PEM private-key blocks into `«redacted:…»`.

That redactor is conservative by design and recognises only high-precision secret shapes, so treat it as a backstop, not a guarantee. Terminal output routinely carries secrets that don't match any of those shapes: pasted tokens, env dumps, `curl -H` lines. Treat enabling this the same way you would treat enabling disk logging — and if you want the summaries without a third party, point `baseUrl` at a self-hosted OpenAI-compatible gateway and set `model` / `writerModel` to ids it serves.

`gateOnActivity` is on by default, so an idle workspace makes no calls at all; `skipIdle` is the narrower backstop for when you turn that gate off.

## See also

- **[The embedded terminal](terminal.md)** — the tabs being summarised, and the OSC / sidecar transcript capture the summariser reads.
- **[Config files → Dashboard](../reference/config.md#dashboard)** — every key with its defaults.
- **[The Settings modal](settings-modal.md)** — where the Dashboard section sits and which file it writes.
