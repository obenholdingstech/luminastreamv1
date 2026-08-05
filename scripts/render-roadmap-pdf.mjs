// Render ROADMAP.md to a PDF the CEO can hold up as the canonical document.
//
// Usage:  node scripts/render-roadmap-pdf.mjs [output.pdf]
// Default output: ./ROADMAP.pdf (repo root, gitignored — the PDF is a
// rendering of ROADMAP.md, never a second source of truth; regenerate it,
// don't edit it).
//
// Runs from the repo root so Playwright resolves from the project
// node_modules (the scratchpad-resolution lesson, 4 Aug 2026).

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { marked } from 'marked';
import { chromium } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mdPath = resolve(repoRoot, 'ROADMAP.md');
const outPath = resolve(repoRoot, process.argv[2] ?? 'ROADMAP.pdf');

const md = readFileSync(mdPath, 'utf8');

// The version line is the second non-empty line: **v2.5 · 4 August 2026**
const version = md.match(/\*\*(v[\d.]+\s*·\s*[^*]+)\*\*/)?.[1]?.trim() ?? '';

const body = marked.parse(md, { gfm: true });

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root {
    --ink: #1c1c1e; --muted: #5b5b60; --rule: #d8d6d2;
    --accent: #6b4fa0; --wash: #f6f4f0;
  }
  * { box-sizing: border-box; }
  body {
    font: 10.5pt/1.55 "Avenir Next", "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: var(--ink); margin: 0; padding: 0;
  }
  h1 {
    font-size: 21pt; font-weight: 700; letter-spacing: -0.01em;
    margin: 0 0 2pt; color: var(--ink);
  }
  h1 + p strong { color: var(--accent); font-size: 11pt; }
  h2 {
    font-size: 15pt; font-weight: 700; margin: 22pt 0 6pt;
    padding-top: 8pt; border-top: 1.5pt solid var(--ink);
    break-after: avoid;
  }
  h3 {
    font-size: 12pt; font-weight: 700; margin: 16pt 0 5pt;
    color: var(--accent); break-after: avoid;
  }
  h4 { font-size: 10.5pt; margin: 12pt 0 4pt; break-after: avoid; }
  p { margin: 0 0 7pt; }
  blockquote {
    margin: 10pt 0; padding: 8pt 12pt; background: var(--wash);
    border-left: 3pt solid var(--accent); break-inside: avoid;
  }
  blockquote p { margin: 0 0 4pt; }
  ul, ol { margin: 0 0 8pt; padding-left: 16pt; }
  li { margin-bottom: 3pt; }
  table {
    border-collapse: collapse; width: 100%; margin: 8pt 0 10pt;
    font-size: 9.5pt; break-inside: avoid;
  }
  th, td { border: 0.5pt solid var(--rule); padding: 4pt 7pt; text-align: left; vertical-align: top; }
  th { background: var(--wash); font-weight: 600; }
  td:first-child { font-weight: 600; white-space: normal; }
  code {
    font: 9pt/1.4 "SF Mono", Menlo, Consolas, monospace;
    background: var(--wash); padding: 0.5pt 3pt; border-radius: 2pt;
  }
  pre {
    background: var(--wash); padding: 8pt 10pt; border-radius: 3pt;
    overflow-x: hidden; white-space: pre-wrap; word-break: break-word;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; }
  hr { border: none; border-top: 0.5pt solid var(--rule); margin: 14pt 0; }
  strong { font-weight: 700; }
  a { color: var(--accent); text-decoration: none; }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.pdf({
    path: outPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `
      <div style="width:100%; font-size:7.5pt; color:#5b5b60; padding:0 16mm;
                  display:flex; justify-content:space-between;
                  font-family:'Avenir Next',Helvetica,Arial,sans-serif;">
        <span>LuminaStream — Roadmap &amp; Canon · ${version}</span>
        <span>page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
  });
} finally {
  await browser.close();
}

console.log(`PDF written: ${outPath} (${version})`);
