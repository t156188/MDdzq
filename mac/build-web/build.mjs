import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../Resources/vendor');

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// The viewer entry that pulls in markdown-it + plugins + highlight.js + KaTeX.
// Mermaid is loaded on-demand from a separate bundle.
await build({
  entryPoints: [resolve(__dirname, 'entries/viewer.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'MDViewer',
  outfile: resolve(outDir, 'viewer.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
});

await build({
  entryPoints: [resolve(__dirname, 'entries/mermaid.entry.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'MDMermaid',
  outfile: resolve(outDir, 'mermaid.bundle.js'),
  target: ['safari16'],
  legalComments: 'none',
});

// Copy the highlight.js + KaTeX CSS so we can ship them as static stylesheets.
const hlCssSrc = resolve(__dirname, 'node_modules/highlight.js/styles/github.css');
const hlCssDarkSrc = resolve(__dirname, 'node_modules/highlight.js/styles/github-dark.css');
const katexCssSrc = resolve(__dirname, 'node_modules/katex/dist/katex.min.css');
const katexFontsSrc = resolve(__dirname, 'node_modules/katex/dist/fonts');

await cp(hlCssSrc, resolve(outDir, 'hljs-light.css'));
await cp(hlCssDarkSrc, resolve(outDir, 'hljs-dark.css'));
await cp(katexCssSrc, resolve(outDir, 'katex.min.css'));
await cp(katexFontsSrc, resolve(outDir, 'fonts'), { recursive: true });

console.log('✅ Front-end assets built to', outDir);
