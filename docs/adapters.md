# Writing an adapter

An adapter teaches the router one vendor CLI. The whole contract is four methods and a small event
stream, defined in [`src/adapters/types.ts`](../src/adapters/types.ts). The four that ship
(`claude.ts`, `codex.ts`, `grok.ts`, `kimi.ts`) are each under a hundred lines and are the best
reference material; this page explains the parts that are not obvious from reading them.

## Ground rules

Two product rules shape every adapter, and pull requests that cross them are declined:

1. **Subscription-backed CLIs only.** The router routes LLM work to tools a person pays a flat
   subscription for. A CLI that only takes metered API keys is not a routing target. A vendor whose
   terms forbid third-party orchestration is out regardless of pricing.
2. **Never touch credentials.** An adapter may check that a credentials file *exists* to answer
   `authStatus`, but it never opens one, never parses one, and never automates a login. When the
   user is not signed in, the adapter's `loginHint` is the exact command they run themselves.

## The contract

```ts
export interface Adapter {
  id: string;                // short stable id: 'claude', 'codex', ...
  displayName: string;       // what the UI shows: 'Claude Code'
  binary: string;            // what must be on PATH: 'claude'
  subscriptionName: string;  // the plan a person buys: 'Claude Pro / Max'
  detect(): Promise<DetectResult>;
  authStatus(): Promise<AuthStatus>;
  run(task: string, opts: RunOptions): AsyncIterable<AdapterEvent>;
}
```

### `detect()`

Answer whether the binary is installed, and its version if it will tell you. Run the CLI's
`--version` (or nearest equivalent) through the `run` helper in
[`src/adapters/spawn.ts`](../src/adapters/spawn.ts): it survives missing and broken binaries and
never throws. A CLI that is not installed is a normal state, not an error; `doctor` shows it as a
quiet "not installed" row.

### `authStatus()`

Answer whether the user is signed in, without touching credentials. Each shipped adapter uses the
gentlest probe its CLI offers: an `auth status` subcommand exit code where one exists, a
file-presence check (`existsSync`, never a read) where one does not. Always return `loginHint`,
even when logged in.

### `run(task, opts)`

Start the CLI headless on one task and translate its output into `AdapterEvent`s:

- `started` once, with the exact command line, so logs can show what actually ran.
- `text` for each streamed chunk the user might want to watch.
- `result` exactly once, with `ok`, the final text, and token usage if the CLI reports it. If the
  CLI states its own API-price cost (Claude does), pass it through as `costUsd`; the router prefers
  a vendor's own figure over list-price math.
- `error` when the process cannot deliver a result at all.

`RunOptions` gives you the model id, an optional reasoning effort, a working directory and a
timeout. Respect all four. The router runs CLIs unattended, so pass the CLI's own non-interactive
flags (see the README's "How it uses your subscriptions" for what that means and why it is stated
openly).

The `streamLines` helper in `spawn.ts` does the process plumbing: it spawns, applies the timeout,
feeds you stdout line by line for parsing, and lets you produce a fallback result if the process
exits without one. Two rules of thumb from the shipped adapters:

- **Tolerate unknown events.** Vendors add event types without notice. Skip lines you do not
  recognise instead of failing the run; a parse failure on one line is never a task failure.
- **Read the result from the most stable channel.** Codex, for one, can write the final message to
  a file (`--output-last-message`) which is far more stable than its JSONL event shapes. Prefer
  that kind of channel when the CLI offers one.

## Registering it

1. Add the adapter to the array in [`src/adapters/index.ts`](../src/adapters/index.ts).
2. Make its models routable: add entries in [`routing-table.json`](../routing-table.json) under
   each category the model is credible in (score, cost weight, typical token appetite), and map
   the benchmark leaderboard names to your CLI's model id in
   [`model-aliases.json`](../model-aliases.json). A model absent from the routing table is never
   selected, however good the adapter.
3. If the vendor publishes list prices, add them to [`model-prices.json`](../model-prices.json) so
   the "what this would have cost" line has data.

## Testing it

The suite runs without any vendor CLI installed, and your adapter tests should too. The pattern in
[`test/failover.test.ts`](../test/failover.test.ts) and `test/usage.test.ts` is to fake the adapter
or the spawn layer and assert on the event stream. Cover at least:

- a clean run producing `started`, some `text`, one `result` with usage,
- a refusal or quota failure mapping to `result` with `ok: false` (vendors often exit 0 on these;
  Claude reports success subtype with an error flag, which is why `claude.ts` checks both),
- a process that dies mid-stream mapping to `error` or a fallback `result`, never a hang.

Then prove it once for real on your machine: `pnpm build && node dist/cli/index.js doctor` should
show your CLI's row, and `node dist/cli/index.js run "say hi" --dry-run` should be able to pick it
when the routing table favours it.

## Checklist for the pull request

- [ ] `detect`, `authStatus`, `run` behave with the CLI missing, present-but-logged-out, and live.
- [ ] No credential file is ever opened. `loginHint` is the vendor's own login command.
- [ ] Timeouts kill the process; nothing leaks.
- [ ] Routing table, aliases and (if available) prices updated together.
- [ ] Tests pass with no vendor CLIs installed: `pnpm test`.
- [ ] One sentence in the PR on the vendor's terms and why orchestration is within them.
