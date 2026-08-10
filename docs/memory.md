# Memory: an OKF knowledge bundle shared across the tailnet

Decision: AiAx Router's durable memory is a Google Open Knowledge
Format bundle, and fleet machines share it over Tailscale. This document is the
binding design. Spec: OKF v0.2, `github.com/GoogleCloudPlatform/knowledge-catalog`
(Apache 2.0). The router pins `okf_version: "0.2"` and follows the spec's
permissive-consumer rules: unknown types, unknown keys, broken links and missing
optional fields are always tolerated, never rejected.

## 1. Three layers, one boundary

- **Episodic history** stays where it is: `tasks/<id>/state.json` (intent,
  decisions, results, review rounds), `results/<id>/` (deliverables),
  `usage.jsonl` (spend). Append-only, never distilled in place.
- **Durable knowledge** lives in `~/.aiax-router/memory/`, an OKF v0.2 bundle.
  Plain markdown with YAML frontmatter. The folder opens directly as an Obsidian
  vault; standard markdown links form the graph.
- **Work sharing** rides the existing fleet mechanism (PRD 6.6): knowledge
  travels inside the handoff brief to the machine doing the work, and what that
  machine learns rides home with the result. Credentials never move; neither
  does the bundle.

## 2. Bundle layout

```
~/.aiax-router/memory/
  index.md            # okf_version: "0.2"; generated listing, progressive disclosure
  log.md              # chronological change history, newest first (OKF section 9)
  preferences/        # type: Preference   how the user wants things done
  people/             # type: Person       contacts and collaborators the user names
  projects/           # type: Project      ongoing work and its constraints
  corrections/        # type: Correction   things the router got wrong, and the fix
  playbooks/          # type: Playbook     multi-step procedures that worked
  services/           # type: Service      external services the user described
  machines/           # type: Machine      fleet peers: capabilities, subscriptions present
```

Type values are producer-defined per the spec. The router emits exactly this
vocabulary and treats any other value as a generic concept.

## 3. Frontmatter contract

Every page the router writes carries:

- `type` (required by spec), `title`, `description`, `tags`
- `generated: { by: aiax-router/<version>, at: <ISO 8601> }`
- `machine: <tailnet hostname>` as a producer extension key, so fleet
  attribution survives without bending the actor convention
- `status`: `draft` when distilled from a single episode, `stable` once
  confirmed, `deprecated` instead of deletion when superseded
- `stale_after`: distilled guesses get +90 days; confirmed facts get +365 days
  or none

User confirmation from the UI appends `verified: { by: human:<name>, at: ... }`
(name from onboarding) and promotes `draft` to `stable`. Trust tiers follow the
spec: human-reviewed > machine-confirmed > unverified.

## 4. Writing: the distiller

After a task completes (and after each answered decision block), a cheap-model
pass reads the episode's `state.json` and extracts durable candidates only:
preferences, corrections, named people, recurring projects, procedures that
worked. Each candidate is deduplicated against the bundle by type + title;
a match updates the existing page (new `generated.at`, `log.md` entry) instead
of creating a sibling. Every write appends one line to `log.md`.

Hard guards, enforced in code before any write:

- **No secrets, ever.** Key/token/password patterns are rejected at the
  distiller and at every network entry point. A page that would contain one is
  dropped and the drop is logged.
- Size cap per page and per distillation round.
- The user's own hand edits are legal input: pages that fail YAML parsing are
  consumed as generic concepts, never rejected and never rewritten.

## 5. Reading: what enters a prompt

The intent stage receives, within a fixed byte budget:

1. The bundle root `index.md` (progressive disclosure, as the spec intends).
2. All stable, human-verified Preference pages (always on).
3. Pages whose type/tags match the task's classification, ranked by trust tier
   then recency (`generated.at`).

Skipped always: `deprecated` pages, and stale pages (`today >= stale_after`),
which are surfaced in Settings for re-confirmation instead.

## 6. Fleet sharing over the tailnet

One bundle is canonical: the coordinator's (the machine the user drives).
Peers never hold a full copy.

- **Knowledge out**: the dispatch payload (PRD 6.6) embeds the selected memory
  pages verbatim in the handoff brief. The peer may fetch a few more pages by
  path during the task through `GET /api/memory/page/<path>` (path-guarded,
  tailnet-only, byte-capped).
- **Knowledge home**: the peer runs the same distiller locally on its episode
  and returns candidate pages with the result payload. The coordinator treats
  them as proposals: they land in `memory-inbox/<machine>/` and merge through
  the same dedupe and secret guards as local distillation, keeping the peer's
  `generated`/`machine` provenance.
- **Conflict rule**: a proposal that contradicts a human-verified stable page
  never overwrites it. It becomes a draft Correction page linking to the page
  it contradicts; when the difference matters for a live task, the user gets a
  normal decision block in street language.
- **API surface** (same server, same tailnet binding rules as PRD 6.5):
  - `GET /api/memory/manifest` - okf_version plus per-page path, type, title,
    description, status, `generated.at` and content hash
  - `GET /api/memory/page/<path>` - one raw page
  - Proposals ride the existing dispatch/result channel; no separate write
    endpoint in v1.

Tailscale remains the only identity boundary, as decided in PRD 6.5. Memory
never leaves the tailnet and is never uploaded anywhere.

## 7. The user-facing surface

Settings gets a "What it remembers" section, street language only, two shelves:

- "You confirmed this" (human-reviewed pages)
- "Picked up along the way" (everything else)

Each row: title, one-line description, and two actions: Confirm (appends
`verified`, promotes to stable) and Forget (deletes the file, logs it). Stale
pages ask "Still true?". The empty state explains, in one sentence, that
memory is a folder of readable files on this computer and nowhere else.

## 8. Implementation notes

- Zero runtime dependencies stands. The router emits a narrow YAML subset and
  parses frontmatter with a small hand-rolled reader: scalars, inline maps,
  string lists, and block lists of inline maps. Anything it cannot parse
  degrades to a generic concept per the spec's conformance rules.
- `src/core/memory.ts` owns bundle IO, selection, distillation and guards;
  the web layer only exposes it. Path handling reuses the existing safeJoin.
- Tests must cover: frontmatter reader on well-formed and hostile input,
  permissive conformance (unknown type, unknown keys, missing optionals,
  broken links), selection budget and trust ranking, secret-guard rejection,
  dedupe-update versus create, proposal merge with provenance preserved, and
  path traversal on the two GET endpoints.
- Attested Computation (spec section 10) is out of scope for the router's own
  bundle in v1; the reader must still tolerate such pages, since users can put
  any OKF content in the folder.
