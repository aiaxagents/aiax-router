# Contributing

Thanks for looking under the hood. This page is the practical stuff; the reasoning behind the
product lives in [docs/PRD.md](docs/PRD.md).

## Getting a dev loop running

Requirements: Node 20 or newer, pnpm, and at least one supported vendor CLI installed and signed in
if you want to run real tasks (the test suite needs none of them).

```bash
pnpm install
pnpm build          # compiles src/ to dist/
pnpm test           # vitest, no network, no vendor CLIs needed
node dist/cli/index.js doctor
```

The app UI is a separate npm project in `web-ui/`:

```bash
pnpm ui:build       # installs and builds web-ui into dist-web/
node dist/cli/index.js board
```

The desktop shell is Tauri v2 (`pnpm app:build`, needs Rust). You rarely need it for engine work:
the board in a browser is the same UI against the same local server.

## What a good change looks like

- **Tests come with it.** Everything in `src/core/` is tested by fakes in `test/`; a routing or
  pipeline change without a test will be asked for one. Run `pnpm test` and `pnpm build` before
  pushing; CI runs exactly those.
- **User-facing words are plain.** Every string a user sees is one short sentence at an average
  reader's level, honest about what is estimated, and free of jargon and em dashes. This is a
  product rule (PRD P0), not a style preference.
- **Comments say why, not what.** The codebase favours a short comment above a block explaining the
  constraint that shaped it. Deliberate simplifications are marked `ponytail:` with their ceiling.
- **No new dependencies without a reason.** The engine is standard library plus TypeScript on
  purpose: a globally installed CLI must not need a compiler or a lockfile audit.

## Hard boundaries

These are product rules; pull requests that cross them will be declined regardless of quality:

- **Never touch credentials.** No reading credential files (presence checks only), no automating
  logins, no OAuth token reuse. See the README's "How it uses your subscriptions".
- **Subscription CLIs only for LLM work.** No metered LLM API keys as routing targets. Media tool
  plugins are the one exception, and they are not LLM routing.
- **Respect vendor terms.** A CLI whose terms forbid third-party orchestration does not get an
  adapter, however good the model behind it is.
- **No telemetry.** Nothing leaves the user's machine. There is nothing to phone home to.

## Adding an adapter

The most useful contribution there is. The interface is four small methods; the guide is
[docs/adapters.md](docs/adapters.md).

## Updating the routing data

`routing-table.json` and `skills-index.json` are refreshed by the weekly workflows in
`.github/workflows/`, which open a pull request rather than pushing. Hand edits are fine between
refreshes; keep `model-aliases.json` honest (never alias a retired model generation onto a floating
CLI id; the file's header comment explains why). If you fork the repo, those two workflows need
"Allow GitHub Actions to create and approve pull requests" enabled under the repository's Actions
settings.

## Releases

Tag `v*` and the release workflow builds the desktop app for macOS (Apple silicon and Intel),
Windows and Linux, and attaches stable-named artifacts (`AiAx-Router.dmg`, `AiAx-Router-Setup.exe`)
that the website's download links point at.
