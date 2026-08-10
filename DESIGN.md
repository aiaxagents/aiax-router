# Design

Starter DESIGN.md, seeded before implementation. Invariants below are fixed; the accent palette and
display typography are deliberately open until one of the coded design directions is chosen
(see docs/PRD.md section 13). Revisit once real code exists to capture actual tokens.

## Theme

Scene: a person at their laptop at home, daytime or evening, opening the app the way they open
ChatGPT, to hand off a task and read an answer. Reading-first, long text answers, ordinary ambient
light. That forces a light-first theme with a system-aware dark variant; dark is a comfort option,
not an identity.

- Light-first, honors `prefers-color-scheme`, user-overridable in Settings.
- Color strategy: **restrained**. Tinted neutrals plus one accent under 10% of the surface. The
  accent hue is chosen by the design direction, not here.
- OKLCH everywhere. No pure `#000` or `#fff`; neutrals tinted toward the accent hue at chroma
  0.005 to 0.01.

## Color roles (hues pending direction choice)

- `surface` / `surface-raised`: near-white tinted neutrals (light), deep tinted neutrals (dark).
- `text` / `text-muted`: high-contrast tinted near-black, muted for metadata.
- `accent`: one hue, used for the composer send action, active nav item, links. Never for large
  fills.
- Status: `running`, `done`, `failed`, `waiting`. Each pairs color with a text label; never
  color-only. Hues checked for deuteranopia/protanopia separation.

## Typography

- Body: a workhorse humanist sans (system stack acceptable in v0), 16px base, line length capped at
  65 to 75ch in chat answers.
- Scale ratio at least 1.25 between steps; hierarchy through size plus weight, never color alone.
- Monospace only inside code blocks and the advanced Usage tab.
- Display face, if any, is a direction-level choice.

## Layout

- App shell: Buzz-pattern sidebar (Inbox, Agents, Tasks, Settings/Usage) plus a chat-first main
  pane with a central composer. Thread panel pattern from Buzz for task detail.
- Kanban: four columns (Backlog, Running, Done, Failed), cards with one plain status line, simple
  progress, one score number. Details behind "show details".
- Spacing varies for rhythm; no uniform padding everywhere. Cards only where a card is genuinely
  the right affordance; never nested cards.

## Motion

- Purposeful only: card column transitions, streaming text, expander open/close.
- Ease-out exponential curves. No bounce, no elastic. Respect `prefers-reduced-motion`.
- Never animate CSS layout properties; transform/opacity only.

## Components (v0 inventory)

- Composer (main input, ChatGPT-like, submit affordance in accent).
- Answer block (streamed text, footer line with score, "show details" expander).
- Decision line (one sentence, muted, inside the expander by default).
- Task card (title, status sentence, progress, score number).
- Sidebar item (icon plus label, active state in accent).
- Onboarding step (one question per screen, plain words, progress dots).
- Result page (`/results/<id>`: rendered report, file list, download).
- Inbox row (own sidebar page in v1: one sentence per finished or waiting result, unread dot,
  link to the result page).

## Hard bans (from PRODUCT.md and standing user rules)

No eyebrow badges. No gradients (including gradient text). No em dashes in UI copy. No side-stripe
borders. No glassmorphism. No hero-metric blocks. No modal-first flows.
