# AGENTS.md — Pyria: Return of the Bits

Guidelines for AI agents and contributors working in this repository.

## Repository Overview

- `site/` — Main landing page & parent-info website hosted at `https://pyria.dev` (Cloudflare Workers Static Assets via `wrangler.site.jsonc`).
- `web/` — Playable browser RPG (`https://play.pyria.dev`), `/console` Parent Console, local `/builder` authoring console, and opaque-origin Pyodide sandbox (`web/py-sandbox.html`).
- `worker/` — Production Cloudflare Worker + D1 backend (`wrangler.jsonc`): auth (Guest Mode, Hero Codes, QR linking/Scan-to-Play, Google OAuth, Email Magic Links), Parent Console API, weekly digest emails, rate limiting, and trial calibration analytics.
- `server/` — Zero-dependency Python 3 + SQLite local dev and content-authoring server (`server/app.py`).
- `content/` — Data-driven JSON curriculum (`content/eras/`, `content/maps/`, `content/catalog.json`, `content/game.json`, `content/schema.json`).
- `assets/` — Sprites, tilesets, concept art, and gameplay screenshots.
- `scripts/` — Asset bundling (`build-assets.mjs`), content validation (`validate-content.mjs`), and calibration reports (`calibration_report.py`).

## Keep the Main Website (`site/`) Accurate

**Before finishing any user-facing change, check whether `site/` needs to be updated so `https://pyria.dev` stays accurate.**

Review `site/index.html`, `site/main.js`, `site/README.md` (and root `README.md` when applicable) whenever a change affects any of the following:

1. **Curriculum & Counts**: Number of playable eras, realms, dragon guardians, or trials; Python concepts taught in each era; or the challenge cadence (multiple-choice intros, fix-the-bug, guided coding trials, boss trials, bonus secrets).
2. **Core Gameplay & UX**: Hero Forge & onboarding calibration, character renaming, Bram's Tinkerer Workshop (gear, consumables, recipes, review challenges), Pip's hint tiers / worked examples / error translations, overworld navigation (thumbstick, auto-path, fast travel), or audio/visual upgrades.
3. **Accounts, Linking & Parent Console**: Guest Mode, Hero Codes, QR linking / Scan-to-Play, Parent Console sign-in methods (Google OAuth, Email Magic Links), weekly progress digest emails, live realm tracking, or per-hero difficulty/hint controls.
4. **Child Safety, Privacy & Compliance FAQ**: Any change affecting what data is stored, how parents review or delete data, Pyodide sandbox isolation/CSP, telemetry/analytics scope, or COPPA/privacy guarantees must be reflected accurately in the Child Safety section and FAQ.
5. **Visuals & Screenshots**: Major visual overhauls to an era, sprites, or the Parent Console may require refreshing screenshots in `site/assets/` and `assets/screenshots/`.
6. **Site Deployment & Headers**: Changes to `wrangler.site.jsonc`, `site/_headers`, or hosting/routing behavior must stay in sync with `site/README.md`.

### `site/` Constraints

- Keep `site/` completely self-contained with **zero third-party trackers, analytics scripts, or external CDNs**.
- Respect the strict CSP in `site/_headers` (`script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`) — do not add inline `<script>` or `<style>` blocks.
- Do not add absolute-URL `_redirects` files under `site/` (unsupported by Cloudflare Workers Static Assets).
- Preview locally with `python3 -m http.server 8090 --directory site`.

## Verification & Tests

Run the relevant test suites before completing changes:

```bash
npm run test:content   # Validate content JSON schemas, AST constructs & curriculum rules
npm run test:web       # Web client & build script unit tests
npm run typecheck      # TypeScript check for worker/
npm test               # Cloudflare Worker + D1 Vitest suite
npm run test:python    # Local Python server unit tests
```

Or run the full verification pipeline:

```bash
npm run test:all
```
