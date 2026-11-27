# Pyria Landing Page (`pyria.dev`)

Self-contained static marketing & parent-info landing page for **Pyria: Return of the Bits**, designed to be hosted at `https://pyria.dev` with primary Play CTAs pointing to `https://play.pyria.dev`.

## Local Preview

```bash
python3 -m http.server 8090 --directory site
```

Then open `http://127.0.0.1:8090`.

## Deploy to Cloudflare Pages (`pyria.dev`)

- **Build command:** *(none — static HTML/CSS/JS)*
- **Build output directory:** `site`
- **Custom domain:** `pyria.dev` (and redirect `www.pyria.dev` → `pyria.dev`)
