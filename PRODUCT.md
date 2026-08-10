# Product

## Register

product

## Users

**Primary: the multi-subscription user.** Not a beginner, not a model nerd. Already pays for two or
three AI services (typically ChatGPT Plus, Claude Pro, and one of Grok or Kimi), is used to the
ChatGPT interface, and wants the best result from the combination without thinking about models,
agents or reasoning levels. Context: at their own computer, personal machine, doing real tasks
(writing, research, small coding jobs, media production). They care about the answer, how long it
takes, and not running out of quota. Routing tables and ROI formulas in the main flow are a product
failure.

**Secondary: the advanced user.** A developer who wants the router as infrastructure, served by the
CLI and the OpenAI-compatible local gateway. They tolerate density; they get the "show details" and
Usage surfaces.

## Product Purpose

AiAx Router is a local-first, MIT-licensed desktop app and CLI that spends the AI subscriptions the
user already pays for in the right order. It routes every task to the provider, model, reasoning
effort and skills with the best quality per token (ROI), runs a per-task pipeline (intent, rewrite,
decompose, dispatch, assemble, five-expert review to 9.5/10), and gets out of the way. Success:
a person with two or three subscriptions gets consistently better results than any single one of
them would give, quota lasts longer, and they never learn what a routing table is.

## Brand Personality

Plain, honest, effortless. The product speaks like a competent friend: one short sentence per
decision, no jargon, no drama. It admits what it does not know ("estimated") and reports failure
plainly. Emotional goal: calm confidence that the machine is spending your money well, the feeling
of ChatGPT-level simplicity with visible good judgement underneath.

## Anti-references

- Model-nerd dashboards: token graphs, ROI formulas, effort levels or provider logos in the main
  flow. Numbers live behind "show details" only.
- SaaS landing-page clichés: hero metrics, gradient accents, eyebrow badges, identical card grids.
- Crypto/neon aesthetics and dark-mode-as-identity tools.
- Vendor branding: no provider's colors or logo may dominate; the product is independent and looks
  it.
- "For dummies" framing: the user is capable, just uninterested in plumbing. Never condescend.

## Design Principles

1. **The answer is the interface.** Chat first, like the ChatGPT app. Everything else (decisions,
   pipeline progress, scores) is one quiet line or lives behind "show details".
2. **One short plain sentence.** Every user-facing string reads at an average reader's level. A
   decision is a sentence, never a calculation. Keep it short, stupid.
3. **Honest by default.** Estimates say "estimated". Failures say what failed and what happens next.
   The review score is a real number, shown as one number.
4. **Invisible machinery.** Routing, failover, compaction and context handoffs never require user
   thought or action. The Kanban board shows work travelling, not internals.
5. **Independence you can feel.** Recommendations are data-driven and vendor-neutral; the interface
   never favours a provider visually or verbally.

## Accessibility & Inclusion

WCAG 2.1 AA target. Copy at average reading level (this is a hard product rule, not just a11y).
Status must never be color-only (Kanban columns and run states carry text labels). Respect
`prefers-reduced-motion`. Full keyboard navigation for composer, board and settings. Color pairs
checked for contrast and common color-vision deficiencies.
