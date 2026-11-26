import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

await mkdir(distDir, { recursive: true });

// 1. Build MCP server (Node ESM)
await build({
  entryPoints: [path.join(rootDir, "src/server/index.ts")],
  outfile: path.join(distDir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});

// 2. Build UI bundle in memory and inline into a single self-contained HTML document
const uiResult = await build({
  entryPoints: [path.join(rootDir, "src/ui/main.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
});

const uiJs = uiResult.outputFiles[0].text;
const uiCss = await readFile(path.join(rootDir, "src/ui/styles.css"), "utf8");

// Escape </script> if it ever appears inside JS string literals
const safeJs = uiJs.replace(/<\/script>/gi, "<\\/script>");
const safeCss = uiCss.replace(/<\/style>/gi, "<\\/style>");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pyria Builder</title>
  <style>${safeCss}</style>
</head>
<body>
  <div id="app">
    <div class="boot-screen">
      <div class="boot-title">Pyria Builder</div>
      <div class="boot-sub">Connecting to Antigravity host...</div>
    </div>
  </div>
  <script>${safeJs}</script>
</body>
</html>
`;

const htmlPath = path.join(distDir, "app.html");
await writeFile(htmlPath, html, "utf8");

const htmlBytes = Buffer.byteLength(html, "utf8");
console.log(
  `Built dist/server.mjs and dist/app.html (${(htmlBytes / 1024).toFixed(1)} KiB)`
);
