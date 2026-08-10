# AiAx Router: Product Requirements Document

**Status:** draft, v0.1
**Repository:** https://github.com/aiaxagents/aiax-router
**License:** MIT
**Last updated:** 2026-08-10

---

## 1. Summary

AiAx Router is a local-first router for AI subscriptions. It sits between a user's task and the
official vendor command-line tools already installed on that user's machine (Claude Code, Codex CLI,
Grok CLI, Kimi CLI), and decides, per task, which provider, which model, which reasoning effort and
which skills should do the work.

The decision is made on ROI: the quality a candidate delivers divided by what it costs in tokens and
in subscription headroom. Quality comes from public benchmarks that are refreshed weekly. Cost comes
from measured or estimated token use per task, plus how much of each subscription is left this cycle.

The router never handles credentials. The user signs in to each vendor CLI themselves, and the router
only starts those CLIs.

---

## 2. Vision and the ROI thesis

### 2.1 The situation

People increasingly hold two or three AI subscriptions at once. A typical set is ChatGPT Plus, Claude
Pro and one of Grok or Kimi. Each subscription is a fixed monthly cost with a rate limit attached.
Nothing that exists today spends that combination well.

Two things go wrong in practice:

1. **Wrong model for the job.** People pick a favourite and use it for everything. A frontier
   reasoning model on a variable rename is waste. A small model on a hard architecture question is a
   worse answer.
2. **Wrong effort for the job.** Reasoning effort is a token multiplier. High effort on easy work
   burns quota without improving the result, and the quota runs out exactly when a hard task arrives.

### 2.2 The thesis

Quality per token is measurable, and it varies enormously by task category and difficulty. If you
know:

- how good each model is in a category (benchmarks),
- roughly how many tokens it needs to finish a typical task in that category,
- how much subscription headroom each provider has left,

then the best choice for a given task is computable, and it is very often not the model the user
would have picked. The router's job is to compute it and then get out of the way.

The value is not "access to many models". The value is **spending subscriptions you already pay for
in the right order**, so that the cheap capacity absorbs the easy work and the expensive capacity is
still there when the work is hard.

### 2.3 What success looks like

- A user with two or three subscriptions gets consistently better results than they would from any
  single one of them, without learning anything about models.
- Quota lasts longer, because trivial work stops landing on frontier models at high effort.
- The whole thing works offline from any AiAx service. Nothing about the product depends on us
  staying online.

---

## 3. Personas

### 3.1 Primary: the multi-subscription user

Not a beginner and not a model nerd. This person already pays for two or three AI services, is used
to the ChatGPT interface, and wants the best result from the combination without thinking about which
model to use.

They care about: the answer, how long it takes, and not running out of quota. They do not care about
routing tables, ROI formulas or effort levels, and showing them those things in the main flow is a
product failure.

Their flow: buy or bring two or three subscriptions (recommended: OpenAI plus Claude plus one more)
→ sign in through the onboarding wizard → chat.

### 3.2 Secondary: the advanced user

A developer who wants the router as infrastructure. Two surfaces serve them:

- **The CLI:** `aiax-router run "<task>"`, with `--dry-run` to see the decision without spending
  anything, plus `doctor`, `status` and `update`.
- **The local gateway:** an OpenAI-compatible endpoint on `127.0.0.1` exposing a virtual model named
  `aiax/auto`. Any tool that speaks the OpenAI chat-completions API (IDEs, agent frameworks, scripts)
  can point at it and get routed automatically. The decision is returned in the response metadata.

### 3.3 Non-persona

Teams that want to share one subscription between several people. That is against every vendor's
terms, and the product will not support it.

---

## 4. Product principles

**P0. Keep it short, stupid.** All user-facing language is plain, short and at an average reader's
level. One sentence for a decision, not a calculation. No jargon in the main flow. Numbers live
behind an explicit "show details".

**P1. Vendor independence.** The project is not sponsored, paid or influenced by any AI vendor.
Routing is decided on merit only: benchmark scores, ROI and remaining quota. Subscription
recommendations come from the same data. This is stated in the README and honoured in the code.

**P2. Subscription-only for LLM work.** The router uses subscription-backed CLIs. It does not take
metered LLM API keys, and it does not fall back to one. Media tool plugins are the one exception, and
they are not LLM routing (see section 12).

Gemini is excluded by this rule. Google sells no consumer subscription for the Gemini CLI, only API
keys, and on 2026-08-04 the CLI free tier was verified closed to third-party orchestration: it
returns `IneligibleTierError` and tells the user to migrate to Antigravity. Gemini returns to the
provider set the day Google ships a subscription-backed CLI.

**P3. Cheapest adequate model wins.** Never a heavy model on easy work, and never high effort where
low effort is enough. Effort is derived from the difficulty of the task, never from the capability of
the model that happens to be selected.

**P4. Never touch credentials.** The router does not read credential files (presence checks only)
and it does not automate any login. The user signs in to each vendor CLI themselves. Runs are
unattended: each CLI is started in its non-interactive mode with its own approval prompts bypassed,
confined to the task's working directory by convention. The flags used are visible in
`src/adapters/` and documented in the README. Per-step sandboxing is planned hardening (6.3).

**P5. Honest about what is estimated.** Quota headroom is real for some providers and estimated for
others. Anything estimated is labelled estimated everywhere it is shown.

**P6. Boring, local storage.** TypeScript, Node 20 or newer, pnpm, one package. State is JSON and
JSONL behind `store.ts`, written atomically (temp file plus rename). No native modules, because a
globally installed CLI must not need a compiler.

---

## 5. Scope

### 5.1 In scope for v1

- Adapters for Claude Code, Codex CLI, Grok CLI, Kimi CLI.
- Routing table with ROI selection, difficulty floors and headroom adjustment.
- The per-task pipeline including the review panel.
- Skills index and skill injection.
- Local web UI (chat plus Kanban) and a Tauri desktop shell.
- OpenAI-compatible local gateway.
- Weekly benchmark and skills research pipelines.
- Media tool plugins.

### 5.2 Out of scope

- Any hosted service, account or payment operated by AiAx.
- Reuse of OAuth tokens or credentials from a vendor CLI.
- Metered LLM API keys as a routing target.
- Multi-user or team sharing of a subscription.
- Tools whose terms forbid third-party orchestration (`opencode` is excluded for this reason).

---

## 6. Architecture

### 6.1 Repository layout

```
aiax-router/
├── routing-table.json      versioned candidate table, hand-seeded v0, weekly PR bot
├── model-aliases.json      benchmark name -> {provider, cliModelId}, hand curated
├── skills-index.json       rated catalog of open agent skills per task category
├── agents/                 built-in agents as pure data: {name, icon, system.md, hints}
├── plugins/                media tool services: manifest plus a thin TS client
├── src/
│   ├── core/
│   │   ├── pipeline.ts     intent -> rewrite -> decompose -> dispatch -> assemble -> review
│   │   ├── router.ts       classify -> select -> dispatch, used per subtask
│   │   ├── classify.ts     model-based classification with a keyword fallback
│   │   ├── select.ts       pure function: (classification, table, availability, usage) -> Decision
│   │   ├── review.ts       five-expert panel, distinct lenses, 9.5 gate, max rounds
│   │   ├── routing-table.ts  load, validate, update (~/.aiax-router overrides the bundled table)
│   │   ├── usage.ts        local counters, headroom, codex rate-limit reader
│   │   ├── store.ts        atomic JSON and JSONL persistence under ~/.aiax-router
│   │   └── types.ts        Category, Difficulty, Effort, Candidate, RoutingTable, Decision
│   ├── adapters/           Adapter interface, spawn.ts, claude, codex, grok, kimi
│   ├── cli/index.ts        doctor, run, status, update, board, serve
│   ├── gateway/serve.ts    OpenAI-compatible POST /v1/chat/completions on 127.0.0.1
│   └── web/                Hono server on 127.0.0.1:4300, SSE, Vite and React UI
├── scripts/build-routing-table.ts
└── .github/workflows/      ci.yml, routing-table.yml, skills-index.yml
```

User state lives in `~/.aiax-router/` (overridable with `AIAX_ROUTER_HOME`): config, usage log,
tasks, an optional local routing table that overrides the bundled one, and results.

### 6.2 The adapter interface

```ts
interface Adapter {
  id: string;
  displayName: string;
  binary: string;
  subscriptionName: string;
  detect(): Promise<{ installed: boolean; version?: string }>;
  authStatus(): Promise<{ loggedIn: boolean; detail?: string; loginHint: string }>;
  run(task: string, opts: RunOptions): AsyncIterable<AdapterEvent>;
}
```

`RunOptions` carries `{ model, effort?, cwd, timeoutMs }`. Events are `started`, `text`, `result`
and `error`. Unknown
event shapes from a CLI are ignored rather than treated as failures, so a vendor adding a new event
type does not break a run.

`loginHint` is the exact command the user runs themselves. The router prints it and stops there.

### 6.3 CLI capability matrix

| CLI | Headless run | Model | Effort | Structured output | Auth check |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `claude -p` | `--model` | `--effort` | `--output-format stream-json` | `claude auth status` exit code |
| Codex CLI | `codex exec` | `-m` | `-c model_reasoning_effort=...` | `--json` plus `--output-last-message` | `codex login status` exit code |
| Grok CLI | `grok -p` | `-m` | `--effort` | `--output-format json` | presence of `~/.grok/auth.json` |
| Kimi CLI | `kimi -p` | `--model` | not exposed | `--output-format stream-json` | `kimi doctor` |

Approvals: every adapter runs its CLI unattended, with the CLI's own approval prompts bypassed
(Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`; Grok
and Kimi auto-approve in `-p` mode). A run that stops to ask a question no one is there to answer
just fails the task, so the router is the gate, not the CLI. Confinement today is the task working
directory by convention. **Planned hardening:** per-step sandbox modes (Codex `-s read-only` /
`-s workspace-write`, Claude permission modes) so classify and review runs are enforced read-only
rather than read-only by instruction.

### 6.4 Local gateway

`src/gateway/serve.ts` exposes `POST /v1/chat/completions` on `127.0.0.1` in the OpenAI shape. The
only model name it accepts is `aiax/auto`. A request is classified, routed and dispatched through the
same `router.run` path as the CLI, and the chosen provider, model and effort come back in the
response metadata. This makes the router consumable by IDEs and agent frameworks as one local
endpoint, which is the pattern OmniRoute and similar tools established.

The gateway binds to loopback by default.

### 6.5 Tailscale: your other computers, seamlessly

*Status: designed, not yet implemented. Today both servers bind to loopback only.*

The router must feel local from every machine the user owns. The mechanism is
Tailscale, not our own auth: with `tailnet: true` in config (or `--tailnet`), the web server and
gateway also bind to the machine's Tailscale address (detected via `tailscale ip -4`, refused if
the detection fails) and `status` prints the MagicDNS URL ("Also on your other computers:
http://mac-mini.tail1234.ts.net:4300"). Nothing ever binds to `0.0.0.0`; exposure is exactly the
user's own tailnet, which is already encrypted and identity-checked by Tailscale. Result links
and SSE URLs are relative, so every page works unchanged from any device. Tasks submitted from a
laptop run on the host machine where the vendor CLIs and subscriptions live; the phone or second
PC is a remote control, never a second brain. This is one person's own devices: the docs say
plainly that serving other people from your subscriptions is against the vendors' terms.
Settings shows one line with the tailnet URL and a copy button when enabled.

### 6.6 Fleet dispatch: several machines, one router

*Status: designed, not yet implemented (the memory layer's sharing rules in 6.7 are built and
tested ahead of it).*

The user may own several machines on the same tailnet, each with different CLIs signed in ("5
maskiner med ulike abonnement"). The router treats them as one pool and shares the load for best
ROI. Principles:

- **Work travels to the credential, never the reverse.** Every machine runs the same
  `aiax-router` binary with its own locally installed, logged-in CLIs. Credentials never leave
  their machine; only the task text, the handoff brief and the result cross the wire.
- **Peer model, no separate server.** A node with `tailnet: true` exposes two extra endpoints on
  its tailnet address: `GET /api/node` (providers, versions, headroom, health, load) and
  `POST /api/dispatch` (run one subtask through the local adapter, stream events back). Peers
  are listed in config (`peers: ["mac-mini.tailXXXX.ts.net"]`, managed by `aiax-router peers
  add|remove|list`); each entry is probed with `/api/node` and cached briefly.
- **Selection is fleet-wide.** Candidates become (machine, provider, model) triples. The same ROI
  formula applies, with each node's own measured or estimated headroom, so a spent quota on the
  desktop routes the next hard task to the laptop's Claude instead. The local node wins ties
  (latency), and a node that stops answering gets the standard dead-cooldown treatment and its
  work re-dispatched.
- **Results come home.** The coordinating node (where the task was submitted) assembles, reviews
  and stores the deliverable; remote subtask output streams back over SSE and lands in the
  coordinator's `~/.aiax-router/results/<id>/`. The drilldown names the machine per subtask, and
  the decision line says it plainly: "Hard coding job, so this runs on your desktop's Claude."
- **Boundary unchanged.** The fleet is one person's own devices on their own tailnet. The docs
  keep saying plainly that serving other people from your subscriptions breaks the vendors'
  terms. No fleet auth of our own: Tailscale is the identity boundary, nothing binds outside it.

### 6.7 Memory: what the router remembers

Durable memory is a Google Open Knowledge Format bundle (OKF v0.2) at `~/.aiax-router/memory/`:
plain markdown pages with YAML frontmatter, one page per fact, readable in any editor and openable
as an Obsidian vault. `docs/memory.md` is the binding design; this is the summary.

- **Three layers.** Episodic history stays where it is (`tasks/<id>/state.json`, `results/`,
  `usage.jsonl`, append-only). Durable knowledge lives in the bundle, distilled from finished
  episodes by a cheap-model pass and deduplicated by type and title. Work sharing rides the fleet
  mechanism: selected pages travel inside the handoff brief, and what a peer learns rides home
  with the result as proposals.
- **Trust tiers.** Pages carry `generated`, `status` and `stale_after`. A page starts as a draft;
  confirming it in Settings appends a `verified` entry with a `human:` actor and promotes it to
  stable. Human-reviewed outranks machine-confirmed outranks unverified when pages are picked for
  a prompt. Deprecated and stale pages never enter a prompt; stale ones ask "Still true?" in
  Settings instead.
- **Tailnet sharing.** One bundle is canonical: the coordinator's. Peers fetch single pages
  through `GET /api/memory/page/<path>` (path-guarded, byte-capped) and return candidate pages
  with results; those land in `memory-inbox/<machine>/` and merge through the same dedupe and
  secret guards. A proposal that contradicts a human-verified stable page never overwrites it;
  it becomes a draft Correction. There is no bulk write endpoint, and the bundle never leaves
  the tailnet.
- **No secrets, ever.** Key, token and password patterns are rejected at the distiller and at
  every network entry; a page that would contain one is dropped and the drop is logged in the
  bundle's `log.md`. Hand edits that break the YAML are consumed as generic concepts, never
  rejected and never rewritten.

---

## 7. The per-task pipeline

This is the core product flow. Every task runs through it unless the user asks for `--simple`, which
skips decomposition but keeps the review gate.

### 7.1 Intent

The best available model in the task's category runs first, regardless of cost. It produces an intent
statement and explicit acceptance criteria.

**Clarification rule:** ambiguities are resolved by the best model, never by a weaker one and never by
bouncing the question to the user by default. The intent model decides. Only when something genuinely
requires the user's own choice (a preference, a missing fact only they have, an irreversible action)
does the product ask, and then it asks exactly one short question in plain language.

This step asks for text only; it is read-only by instruction (enforced sandboxing is planned, 6.3).

### 7.2 Rewrite

The same model rewrites the task so that it is optimal for the model that will execute it. Prompt
style, level of detail and structure differ between models, and the rewrite adapts to the target.

### 7.3 Decompose

The task is split into subtasks. Each subtask carries a `category` and a `difficulty`. Dependencies
between subtasks are recorded so that independent ones can run in parallel.

### 7.4 Dispatch

Each subtask goes through `classify -> select -> run`:

- **classify** confirms category and difficulty (cheapest model, keyword fallback if no model is
  available).
- **select** produces a `Decision` (provider, model, effort, one-sentence rationale, ranked
  alternatives) using the ROI formula in section 8.
- **run** starts the chosen adapter with the selected skills injected: natively where the CLI has a
  skills mechanism (Claude Code), otherwise inlined into the rewritten prompt.

Media tool plugins are attached here when the subtask needs image or video production. Default
permission is `workspace-write` scoped to the task working directory.

### 7.5 Assemble

The model from the intent step merges the subtask results into one deliverable, checked against the
acceptance criteria from step 7.1.

### 7.6 Review loop

A panel of five reviewers, ideally spread across different providers so that the panel does not share
one model's blind spots. Each has a distinct lens:

1. **Correctness:** is it right?
2. **Completeness:** does it satisfy the intent and every acceptance criterion?
3. **Quality and style:** is it well made and well written?
4. **Robustness and safety:** what breaks, what is unsafe?
5. **Simplicity:** is anything unnecessary, over-built or duplicated?

Each reviewer scores 1 to 10 with a written justification. Reviewers only produce scores and notes;
they are read-only by instruction (enforced sandboxing is planned, 6.3).

- Average below 9.5: the specific gaps are turned into a revision round, and only the deficient parts
  are re-dispatched. The rest is not regenerated.
- Loop until the average reaches 9.5, or until `maxReviewRounds` (default 4, configurable) is hit. At
  the cap, the product reports the best score honestly along with what is still missing. It does not
  keep spinning, because rounds cost real quota.

Reviewer model tier scales with task difficulty: trivial work gets cheap reviewers. The 9.5 threshold
does not move.

---

## 8. Routing table and ROI selection

### 8.1 Schema

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-04T00:00:00Z",
  "sources": [{ "name": "lmarena", "fetchedAt": "..." }],
  "categories": {
    "coding": [
      {
        "provider": "codex",
        "model": "gpt-5.5-codex",
        "score": 92,          // normalized quality 0-100 for this category
        "costWeight": 3,      // 1-5, how much subscription headroom a run spends (0-1 = free tier)
        "tokensPerTask": 1.4, // relative tokens for a typical task in this category (1 = baseline)
        "maxEffort": "xhigh"
      }
    ]
  },
  "difficultyFloor": { "trivial": 0, "easy": 40, "medium": 65, "hard": 80 }
}
```

Categories: `coding`, `agentic-coding`, `reasoning`, `writing`, `chat`, `long-context`.

### 8.2 Selection

1. **Availability filter.** Keep candidates whose provider CLI is installed, signed in and not
   disabled by the user.
2. **Difficulty floor.** Keep candidates with `score >= difficultyFloor[difficulty]`. This is the
   "adequate" test: below the floor, a model is not a candidate at any price.
3. **ROI ranking.** Rank the survivors by

   ```
   ROI = score / (tokensPerTask * costWeight)
   ```

4. **Headroom adjustment.** Multiply each candidate's ROI by `headroom` for its provider, so a
   provider that is nearly out of quota falls behind an equally good one that is not. A provider below
   5 percent headroom is skipped entirely, with "that subscription is used up" in the rationale.
5. **Effort.** Derived from difficulty, then clamped by the candidate's `maxEffort`:
   `trivial -> low`, `easy -> low`, `medium -> medium`, `hard -> high` (with `xhigh` reserved for hard
   work in reasoning-heavy categories). Effort is never raised because the selected model supports it.
   Higher effort costs measurably more tokens, so it is spent only where difficulty demands it.
6. **Output.** A `Decision` with provider, model, effort, one short plain-language rationale, and
   ranked alternatives with a one-line reason each.

`select.ts` is a pure function of `(classification, table, availability, usage)`. That keeps it unit
testable without spawning anything, and it is the piece with the most tests.

### 8.3 What the user sees

One sentence, for example: "Codex is doing this, it is the strongest coder you have and this is a
hard job." The ROI numbers, the ranked alternatives and the headroom figures live in "show details"
and in the Usage tab. Never in the main flow.

---

## 9. Quota and headroom honesty

Headroom quality differs per provider, and the product says so rather than pretending otherwise.

| Provider | Source of headroom | Quality |
| --- | --- | --- |
| Codex | Real rate-limit snapshots parsed from the session JSONL logs the CLI writes | Real |
| Claude | Local counters plus optional parsing of `~/.claude/projects/**/*.jsonl`, compared to the plan tier the user configured | Estimated |
| Grok | Local counters against a user-set budget | Estimated |
| Kimi | Local counters against a user-set budget | Estimated |

Rules:

- Every run appends to `usage.jsonl`: timestamp, provider, model, effort, category, difficulty, token
  counts when the CLI reports them, duration and outcome.
- `aiax-router status` labels every estimated number as "estimated". No exceptions.
- Budgets and plan tiers are user editable, because our guess about their plan is worse than their
  knowledge of it.
- The 5 percent floor is a hard skip, not a soft penalty, so a nearly exhausted subscription is not
  drained by the router right before the user needs it themselves.

---

## 10. Weekly benchmark pipeline

A GitHub Action runs weekly, rebuilds `routing-table.json` and opens a pull request. It never merges
itself.

**Sources:**

- **LMArena**, via the Hugging Face dataset `lmarena-ai/leaderboard-dataset`.
- **LiveBench**, for reasoning and coding splits.
- **Aider polyglot**, from the raw YAML in the project repository.
- **SWE-bench**, best effort, since its published JSON shape is not stable.

**Normalization:** raw scores are normalized to 0-100 per category, so that a leaderboard using
Elo and one using percentage solved can sit in the same table.

**Mapping:** benchmark model names are mapped to CLI model IDs through the hand-curated
`model-aliases.json`. Names never match automatically (a leaderboard entry and a CLI `-m` value are
different strings maintained by different people), and guessing produces a router that silently sends
work to a model that does not exist. Unmapped top models are listed in the pull request as a
checklist for a human to resolve.

**Artificial Analysis:** AA's Data API is the best source for tokens per task, because it measures
token use and not only quality. Its free tier is licensed for internal use with no redistribution, so
**AA numbers are never committed to the repository**. Instead, `aiax-router update` enriches
`tokensPerTask` client-side using the user's own free AA key from their local config. Without an AA
key, the router falls back to open sources plus a coarse tier heuristic, and the table says which
mode produced it.

`aiax-router update` fetches the raw table from the repository's main branch and prints the version
it landed on.

---

## 11. Skills index

Models are not the only thing worth routing. A good agent skill (a packaged instruction set for a
task type) often improves output more than a model upgrade does, and open skills are scattered across
registries, GitHub and community collections.

`skills-index.json` is a curated, rated catalog of the best open agent skills per task category, with
the same regime as the routing table:

- A weekly research job (its own GitHub Action) refreshes ratings and picks up new skills, then opens
  a pull request for human review.
- At dispatch, the router selects the skills that fit the subtask and injects them into the executing
  agent: through the CLI's native skills mechanism where one exists (Claude Code), otherwise by
  inlining the skill instructions into the rewritten prompt.
- v0 is hand seeded.
- The user sees one line: "Using skill: pdf-report". Nothing more.

---

## 12. Built-in agents and media tool plugins

### 12.1 Built-in agents

`agents/` holds a library of preconfigured agents (writer, coder, researcher, analyst, designer and
others). Each is pure data: name, icon, system prompt, category hints. No agent contains routing
logic, because the router does that part. The format is simple enough that the community can
contribute agents in a pull request without touching TypeScript.

### 12.2 Media tool plugins

Some work (video, image generation, marketing production) needs paid tool services. `plugins/` holds
manifests plus thin TypeScript clients for Higgsfield, Fal.ai and Kie.ai.

Rules:

- The user buys directly from the provider and pastes their own key into Settings. We are not a
  reseller and we take no cut.
- These services are **clearly labelled as metered**, so the user knows a run costs money per call,
  unlike their flat-rate subscriptions.
- This does not change the LLM rule. LLM routing stays subscription-only. Media tools are tools, not
  models.
- Built-in agents (a video agent, a marketing agent) pick these up automatically when a task needs
  them, and say so.

### 12.3 The plugin boundary: MCP or CLI, nothing else

This repository is fully public and must stay clean enough that anyone can read every line:

- A plugin integrates through exactly two shapes: a **public MCP server** the user connects, or an
  **installed CLI** the router spawns. Nothing else. The repo holds only the manifest (name, what
  it does, pricing link, how to connect) and, where needed, a thin generic client for a public,
  documented API surface.
- **No proprietary knowledge in the repo.** Nothing in this codebase may reveal how AiAxmail,
  AiAx Inbox or any other AiAx service works internally: no internal endpoints, no schemas, no
  behavior only an insider could know. The AiAxmail plugin is specified against its public MCP/CLI
  surface alone, exactly as a stranger on GitHub would see it. If a capability is not publicly
  documented by the service, the router does not know it exists.
- **No secrets, ever.** User keys live in `~/.aiax-router/config.json` on the user's machine and
  nothing else. The repo, its history, its tests and its fixtures contain no keys, tokens or
  real account data. Test addresses use example.com.
- **License hygiene.** MIT for our code. Bundled fonts carry their own OFL license files beside
  them. Benchmark data comes only from redistributable sources; Artificial Analysis numbers are
  fetched client-side with the user's own key and never committed. Brand logos are used for
  identification per each brand's guidelines, sourced from official assets, never redrawn.

---

## 13. UI direction

The reference is Block's Buzz (https://github.com/block/buzz, Apache 2.0): a Tauri v2 and React
desktop app with a Slack-like sidebar, thread panel and agents as first-class members. We use it as a
layout pattern reference, not for branding. The second reference is the ChatGPT app, for the
chat-first main page.

**Stack:** Tauri v2 plus React, the same stack as Buzz. The UI code is plain TypeScript and React,
shared between the desktop app and `aiax-router board`, which serves the identical UI in a browser.
Rust is needed only to build the app shell. Core process: Hono on `127.0.0.1:4300` with SSE at
`/api/events`.

**Main page:** chat first. A central composer, and you write what you want done. The decision line,
ROI and pipeline progress sit behind a quiet "show details" expander on the answer, not in the main
flow.

**Page two, Tasks:** a Kanban board with four columns (Backlog, Running, Done, Failed). Tasks arrive
here and travel across until they are done. A card shows one short plain-language status line ("Claude
is working on this, hard coding job"), subtask progress as a simple progression, and the panel score
as a single number. Full decision, ROI and logs behind "show details". Tasks persist in `tasks.json`,
and cards left in Running by a crash are marked Failed at startup.

**Sidebar:** Inbox (finished and waiting results), Agents (the built-in agent library), Tasks
(Kanban), Settings and Usage (subscription status from doctor, headroom and ROI, marked as the
advanced tab).

**Result URLs:** every finished task gets a local URL, `/results/<id>`, where the finished product is
shown: rendered report, preview of a site or app, file list with downloads. Done cards and chat
answers link there. Deliverables are stored in `~/.aiax-router/results/<id>/` and served by the same
local server.

**Onboarding wizard (first run):** recommends a subscription combination (OpenAI plus Claude plus one
of Grok or Kimi) with links to buy, installs missing vendor CLIs with the user's consent (brew,
winget, npm), then starts each vendor's own login flow and verifies the result. It never automates the
login itself.

**Design constraints:** no eyebrow badges, no gradients, no em dashes in UI copy.

### 13.1 M6 as built: how the desktop app ships (2026-08-05)

**Shipped: Node SEA, no bundled-runtime fallback needed.** The server and CLI are bundled by esbuild
into one CommonJS file, turned into a blob with `node --experimental-sea-config`, and injected into a
copy of an official Node binary with postject. The result is a single 137 MB executable that Tauri
carries as an `externalBin` sidecar. Nothing is installed on the user's machine: no Node, no CLI, no
package manager.

Two things forced a detail worth writing down. First, single executable applications are compiled out
of shared-library Node builds, which is what Homebrew ships, so the build script fetches the official
Node build for the target instead and verifies it against the release's own `SHASUMS256.txt`. That is
required anyway: a Homebrew Node links against dylibs that exist on nobody else's machine. Second,
esbuild's CommonJS output has no `import.meta.url`, so the bundle step rewrites it to the equivalent
`pathToFileURL(__filename)` expression rather than leave an empty shim behind.

**How the shell and the server meet.** The Rust shell spawns the sidecar as `board --port 0
--no-open`, so the app takes a free port and can run beside a terminal already serving the board on
4300. It reads the port off the server's own startup line, then points the window there. The shell
holds no application logic: everything the window shows is served by the same code path as
`aiax-router board`.

**Data files.** A single executable has no package directory around it, so the files the router ships
with (`dist-web/`, `agents/`, `plugins/`, `routing-table.json`, `skills-index.json`) go into the
bundle's resource folder and the shell passes `AIAX_ROUTER_ASSETS`. Unset, which is every terminal
install, resolution is unchanged.

**Shutting down.** The shell kills the sidecar on exit. Because a kill the shell never sees would
otherwise leave a board running behind no window, the shell also holds the server's stdin and the
server stops when that pipe closes. This is opt in via `AIAX_ROUTER_WATCH_STDIN`, since a terminal
keeps stdin open and the CLI must not inherit the behaviour.

**Reachability.** The window is built in Rust rather than declared in `tauri.conf.json`, because the
loopback navigation guard is a window builder option. Only `http://127.0.0.1`, `http://localhost` and
Tauri's own schemes may load. The board page is remote as far as Tauri is concerned, so it gets no IPC
surface at all.

---

## 14. Prior art

**OmniRoute** (https://github.com/diegosouzapw/OmniRoute, MIT) is the closest prior art: a local
router that presents itself as one endpoint with automatic routing across providers.

What we do differently:

1. **Terms-safe CLI orchestration.** OmniRoute leans on reusing OAuth credentials. We never touch
   credentials, and we orchestrate the vendors' own CLIs instead. This is the difference between a
   tool a user can safely run and one that puts their account at risk.
2. **Benchmark-driven ROI table.** Routing is data, refreshed weekly in public, not a hand-written
   rule set.
3. **Intent and review pipeline.** Routing a request to a model is one step of six. The intent,
   rewrite, decompose, assemble and review steps are where most of the quality gain comes from.
4. **A real app.** A Buzz-like desktop and browser app aimed at a person with subscriptions, not only
   a proxy for developers.

---

## 15. Milestones

| M | Deliverable | Exit criteria |
| --- | --- | --- |
| M1 | Skeleton, adapter interface, `spawn.ts`, all four adapters, `doctor` | Correct doctor output on a real machine, graceful "not installed" rows in CI |
| M2 | Hand-seeded routing table, `select.ts` with unit tests, heuristic classifier, `run` with streaming and the decision line printed first | `run "rename x to y" --dry-run` picks a cheap model at low effort |
| M3 | Model-based classifier, `usage.jsonl`, Codex rate-limit reader, `status`, `serve` with the `aiax/auto` gateway | `status` shows real Codex headroom and labelled estimates, gateway answers an OpenAI-shaped request |
| M4 | Pipeline (intent, rewrite, decompose, assemble) and the review panel loop, plus skill injection with a hand-seeded skills index | A task reaches an average of 9.5 or reports an honest gap at the round cap |
| M5 | Web UI: chat-first main page, Kanban, built-in agents, onboarding wizard | Verified in a running browser, design judge score above 9.5 |
| M6 | Tauri v2 desktop shell around the same UI, release CI for Mac, Windows and Linux (tailnet serving from section 6.5 moved out to a later milestone) | The app opens and runs a task end to end |
| M7 | Weekly research pipelines (benchmarks and skills index), `update` including client-side AA enrichment | A bot pull request lands with a diffable table |
| M8 | Media tool plugins (Higgsfield, Fal.ai, Kie.ai), Settings key flow, video and marketing agents, plus scheduled tasks (created in plain words in chat, shown on a Scheduled shelf on the Tasks page, fired by a local scheduler) and the Booking agent booking over real email through AiAxmail | An agent produces a media deliverable from a chat task; a scheduled task fires on time and lands on the board |

| M9 | Fleet dispatch over Tailscale (section 6.6): peers config, `/api/node` and `/api/dispatch`, fleet-wide ROI selection, per-node health | A hard task submitted on machine A runs on machine B's provider because B has the headroom, and the drilldown names the machine |

Post-MVP idea, not in scope now: a Buzz integration so that the router can act as an agent inside a
Buzz workspace and accept tasks from there.

---

## 16. Risks and mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | **Vendor CLI churn.** Flags, event shapes and model IDs change without notice. | Adapters tolerate unknown event types instead of failing. `doctor` logs versions. A nightly smoke test runs each installed adapter on a trivial prompt. Each adapter reads the final answer from the most stable channel available (for Codex, `--output-last-message` rather than the JSONL shape). |
| 2 | **Terms drift.** A vendor changes what third-party orchestration is allowed. | Strictly local, credentials never read, no login automation, and every flag the router sends is documented openly in the README and visible in `src/adapters/`. The position is documented so a change is easy to reassess. Tools whose terms forbid this are excluded outright. |
| 3 | **Benchmark names do not match CLI model IDs.** | Hand-curated `model-aliases.json`. The weekly bot never guesses: unmapped top models become a checklist item in the pull request, and an unmapped model is simply absent from the table. |
| 4 | **Quota estimates are wrong.** | Everything estimated is labelled estimated. Budgets and plan tiers are user editable. The 5 percent floor stops the router before it drains a subscription. |
| 5 | **Headless auto-approval is dangerous.** Every CLI runs unattended with approvals bypassed. | Each task runs in its own fresh working directory. The README states plainly what unattended mode means and which flags are sent, so the user can decide what to hand the router. Per-step enforced sandboxing (read-only classify and review) is the tracked hardening in 6.3. |
| 6 | **Review loop cost.** Five reviewers per round is expensive. | Hard round cap (default 4) with an honest gap report. Reviewer tier scales down with difficulty. Only deficient parts are re-dispatched, never the whole result. |

### Unverified, to be confirmed during build

- Whether Kimi CLI exposes any reasoning effort control.
- Whether Grok CLI has an auth-status subcommand (currently a file presence check).
- The exact field names in the Codex session JSONL rate-limit snapshots.
- Whether the SWE-bench published JSON is stable enough to parse weekly.

---

## 17. Open product questions

1. Should the router ever pick a provider the user has not signed into, purely to show what they are
   missing? Current answer: no in routing, yes as a single line in the Usage tab.
2. How much of the pipeline should run for a one-line chat message? Current answer: `--simple` skips
   decomposition and keeps the review gate, and the UI applies it automatically for short chat turns.
3. Should the review panel be optional? Current answer: no by default. It is the main quality
   mechanism, and the round cap already bounds its cost.
