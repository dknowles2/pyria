# Pyria Landing Page (`pyria.dev`)

Self-contained static marketing & parent-info landing page for **Pyria: Return of the Bits**, deployed via **Cloudflare Workers Static Assets** (`wrangler.site.jsonc`) at `https://pyria.dev` with primary Play CTAs pointing to `https://play.pyria.dev`.

## Local Preview

```bash
python3 -m http.server 8090 --directory site
```

Then open `http://127.0.0.1:8090`.

## Deploy to Cloudflare Workers (`pyria.dev`)

Deploys automatically on every push to `main` via `.github/workflows/deploy.yml`, or manually from the repo root:

```bash
npm run deploy:site
```

- **Worker name:** `pyria-site` (configured in `../wrangler.site.jsonc`)
- **Custom domains:** `pyria.dev` and `www.pyria.dev` (configured in `../wrangler.site.jsonc`)
- **Security headers:** Configured via `_headers` (strict CSP, `nosniff`, `DENY` framing)
