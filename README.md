# AiAx Router

A local-first, MIT-licensed router that gets the best out of the AI subscriptions you already pay
for.

- **Picks for you.** Provider, model, reasoning effort and skills are chosen per task by ROI, which
  means quality per token spent.
- **Never touches your credentials.** It runs the official vendor CLIs that you installed and signed
  into yourself: Claude Code, Codex CLI, Grok CLI and Kimi CLI.
- **Stays current.** Routing is informed by public benchmarks that refresh weekly, and by how much of
  each subscription you have left this cycle.

Everything runs on your machine. There is no AiAx account, no payment and no server in the middle.

**Download the app:** [aiaxrouter.com](https://aiaxrouter.com), or grab
[AiAx-Router.dmg](https://github.com/aiaxagents/aiax-router/releases/latest/download/AiAx-Router.dmg)
(macOS, Apple silicon) or
[AiAx-Router-Setup.exe](https://github.com/aiaxagents/aiax-router/releases/latest/download/AiAx-Router-Setup.exe)
(Windows) from the [releases page](https://github.com/aiaxagents/aiax-router/releases), which also
carries Intel Mac and Linux builds. The builds are unsigned for now, so the first launch needs the
usual "open anyway" step.

## How it works

Every task goes through the same pipeline:

1. **Intent.** The best model available reads your task and writes down what "done" means. It settles
   anything unclear itself and tells you what it decided. The few points that really need you are
   listed at the end under "Needs your call".
2. **Rewrite.** The same model rewrites the task so it fits the model that will actually do the work.
3. **Split.** The task is broken into subtasks, each tagged with a category and a difficulty.
4. **Dispatch.** Each subtask goes to the cheapest model that is good enough for it, at the right
   reasoning effort, with the right skills attached. Easy parts go to cheap or free models.
   Independent parts run in parallel.
5. **Assemble.** The parts are put back together into one result.
6. **Review.** A panel of five expert reviewers, each with a different lens (correctness,
   completeness, quality, robustness, simplicity), scores the result from 1 to 10. The result passes
   when the average reaches 9.5 and no single reviewer sits at 9 or below. Anything less and the
   specific gaps go back for another round, up to four rounds, after which it tells you honestly
   what is still missing.

You see one short line about what was chosen and why. The numbers behind it are there if you open
the details.

### Choosing, and failing over

Selection is ROI: each candidate model has a benchmark score per task category, a cost weight and a
typical token appetite, all in [routing-table.json](routing-table.json). The cheapest model that
clears the difficulty floor for the task wins, adjusted for how much of each subscription you have
left this cycle. Reasoning effort comes from the difficulty of the task, never from the model that
happened to be picked.

When a run fails, whatever the reason, the task moves to the next candidate in ROI order. Failures
that look like exhaustion or an outage (the patterns live in `src/core/usage.ts`) additionally bench
that provider for a while so the next tasks stop tripping over it.

### The layout

```
src/adapters/   one file per vendor CLI (claude, codex, grok, kimi) + the spawn helpers
src/core/       pipeline, classifier, ROI selection, review panel, memory, usage, prices
src/cli/        the aiax-router command
src/gateway/    OpenAI-compatible local endpoint exposing the virtual model aiax/auto
src/web/        local server behind the app: tasks, results, activity
web-ui/         the app itself (React): chat, board, agents, plugins, settings
src-tauri/      Tauri v2 desktop shell that carries the server as a Node sidecar
agents/         built-in agent templates (researcher, coder, writer, ...)
plugins/        media tool plugin manifests (metered, user-supplied keys)
scripts/        weekly research pipelines that refresh the routing and skills tables
docs/           the PRD and deeper design docs
site/           aiaxrouter.com, a static page
```

## Quick start

The easiest path is the desktop app above: it walks you through which CLIs it found at first
launch. From there it is chat.

For the CLI, build from source. Requirements: Node 20 or newer, and pnpm.

```bash
git clone https://github.com/aiaxagents/aiax-router && cd aiax-router
pnpm install && pnpm build
pnpm link --global
aiax-router doctor
```

`doctor` lists every supported CLI, whether it is installed, and whether you are signed in. Tools
you do not have simply show as not installed. Then:

```bash
aiax-router run "write a haiku about routing tables"   # one task, reviewed
aiax-router run "..." --dry-run                        # show the pick, run nothing
aiax-router board                                      # the app in your browser
aiax-router status                                     # headroom and recent runs
aiax-router serve                                      # OpenAI-compatible gateway
```

The gateway serves `POST /v1/chat/completions` on `127.0.0.1` with a virtual model named
`aiax/auto`, so anything that speaks the OpenAI API can point at it and get routed.

### Which subscriptions to get

The router gets better the more it has to choose between. A good combination is:

- OpenAI (ChatGPT Plus or Pro), used through Codex CLI
- Claude (Pro or Max), used through Claude Code
- One more: Grok (SuperGrok) or Kimi

Two subscriptions are enough to start. You sign in to each CLI yourself, in that CLI's own login
flow.

## Independent by design

AiAx Router is not sponsored by, paid by or affiliated with any AI vendor. Not Anthropic, not OpenAI,
not xAI, not Moonshot.

Routing is decided on merit only: benchmark scores, ROI and how much quota you have left. When the
product recommends a subscription, that recommendation comes from the same data and nothing else.

## How it uses your subscriptions

This part matters, so it is stated plainly.

The router **never reads, stores or proxies your credentials**. It never automates a login. It
checks that a login exists (for some CLIs by checking that a credentials file is present, never by
opening it), and if you are not signed in it prints the vendor's own login command and stops there.

What it does is run the official command-line tools that you installed and signed into yourself, the
same way a build tool runs a compiler: it starts the CLI with a task, a model and an effort level.

**Runs are unattended.** Nobody is at the keyboard to answer an approval prompt, so each CLI is
started in its non-interactive mode with its own approval prompts bypassed (for example
`--dangerously-skip-permissions` for Claude Code and `--dangerously-bypass-approvals-and-sandbox`
for Codex; the exact flags are in `src/adapters/`). Each app task gets its own fresh working
directory under `~/.aiax-router/tasks/<id>/`, and that directory is where the CLI is started. Treat
a task you hand the router the way you would treat any script you run unattended on your machine:
an agent CLI in full-auto mode can read files and reach the network as your user. Stricter per-step
sandboxing is planned hardening, tracked in [docs/PRD.md](docs/PRD.md) section 6.3.

Each vendor's own terms apply to your use of their CLI. The router adds no way around them, and it
is not a way to share one subscription between people.

## Status

Developer preview. The engine, the app and the release pipeline are built and tested:

| Milestone | What it delivers | State |
| --- | --- | --- |
| M1 | Adapters for Claude, Codex, Grok and Kimi, plus the `doctor` command | Done |
| M2 | Routing table, ROI selection and the `run` command with live output | Done |
| M3 | Model-based task classifier, usage tracking, and the local OpenAI-compatible gateway | Done |
| M4 | The full pipeline (intent, rewrite, split, assemble) and the five-expert review panel | Done |
| M5 | The app: chat-first main page, Kanban board, built-in agents, onboarding | Done |
| M6 | Tauri desktop shell around the same UI, with release builds for Mac, Windows and Linux | Done |
| M7 | Weekly research pipelines for the benchmark table and the skills index, and the `update` command | Done |
| M8 | Media tool plugin catalog (Higgsfield, Fal.ai, Kie.ai) with the Settings key flow, and the built-in agent library | Done |

Designed but not built yet, in honest order: bring-your-own API keys through aggregators such as
[OpenRouter](https://openrouter.ai) and [Eden AI](https://app.edenai.run/models), so the benchmark
table can also route to pay-per-token models when one of them is the best fit for a task; scheduled
tasks that fire on their own; plugins as callable tools inside a run; serving the app to your other
computers over Tailscale; and enforced per-step sandboxing. Already growing: a durable memory, an open-format knowledge bundle the router
distills from finished tasks ([docs/memory.md](docs/memory.md)). The full product definition is in
[docs/PRD.md](docs/PRD.md).

## Contributing

Contributions are welcome, adapters most of all: the interface is four small methods, documented in
[docs/adapters.md](docs/adapters.md). Read [CONTRIBUTING.md](CONTRIBUTING.md) for how the project
works day to day.

## License

MIT. See [LICENSE](LICENSE).
