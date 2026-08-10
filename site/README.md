# aiaxrouter.com

Static marketing site. No build step: deploy this directory as-is to any static host
and point aiaxrouter.com at it.

## Design tokens

Shared ledger look with aiaxmail.com: warm paper, ink type, a golden field for the
moments that matter.

- Paper `oklch(0.981 0.008 82)`, ink `oklch(0.245 0.014 65)`, rule `oklch(0.888 0.012 78)`.
- Gold field `oklch(0.868 0.158 92)` with deep gold `oklch(0.74 0.145 88)` for accents.
- Type: Schibsted Grotesk variable (self-hosted, `assets/sg.woff2`), weight 900 for display,
  400 body, mono stack for the dispatch log and ledger labels.
  The font is SIL OFL 1.1; its license ships alongside as `assets/OFL.txt`.
- Flat color blocks and 1px hairlines. No gradients, no em dashes.

## Assets

- `assets/run.mp4` + `assets/run-poster.png`: screen recording of one real task in the
  app (chat submit, dispatch, board, drilldown). Recorded headless against
  `aiax-router board` with a fresh `AIAX_ROUTER_HOME`; re-record when the UI changes.
- `assets/og.png`: social share card, 1200x630 ratio.
- The hero "dispatch log" film is not an asset: it is plain HTML rows animated by the
  inline script in `index.html`.

Download buttons point at `github.com/aiaxagents/aiax-router/releases/latest/download/`
with asset names `AiAx-Router.dmg` and `AiAx-Router-Setup.exe`. Keep release asset names
in sync with those links.
