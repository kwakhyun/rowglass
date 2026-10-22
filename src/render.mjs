import { readFile } from 'node:fs/promises';
import { parseCSV, reconcile } from './engine.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
export function safeJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function renderApp(report = null, { sample: isSample = false } = {}) {
  const [engine, ui, style, before, after] = await Promise.all([
    read('./engine.mjs'), read('./ui.mjs'), read('./ui.css'),
    read('../examples/before.csv'), read('../examples/after.csv'),
  ]);
  const sample = reconcile(parseCSV(before), parseCSV(after), {
    keys: ['account'], value: 'amount', beforeName: 'before.csv', afterName: 'after.csv',
  });
  const state = { report: report || sample, sample: !report || isSample, example: sample };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="description" content="Explain a changed CSV total, down to the rows. A local, offline comparison tool.">
<title>Rowglass — Follow the difference</title><style>${style}</style></head>
<body>
<header class="topbar"><a href="#" class="brand" aria-label="Rowglass home"><span class="mark">≋</span> rowglass<span class="version">0.1</span></a><div class="top-actions"><span class="local"><i></i> Runs in this file</span><button id="export-html" class="primary">Save report <span aria-hidden="true">↗</span></button></div></header>
<main>
<section class="intro"><div><p class="eyebrow">FOLLOW THE DIFFERENCE</p><h1>Where did the total go?</h1><p class="subhead">Two CSVs. One clear explanation. Every change, traced to a row.</p></div><button id="sample-button" class="text-button">Load example <span aria-hidden="true">↻</span></button></section>
<section class="input-panel" aria-label="Compare your CSV files">
<div class="file-pair"><label class="file-label"><span class="step">01</span><span><strong>Before</strong><span id="before-file-label">Choose a CSV file</span></span><input type="file" id="before-file" accept=".csv,.tsv,text/csv,text/tab-separated-values" aria-label="Before CSV file"></label><span class="pair-arrow" aria-hidden="true">→</span><label class="file-label"><span class="step">02</span><span><strong>After</strong><span id="after-file-label">Choose a CSV file</span></span><input type="file" id="after-file" accept=".csv,.tsv,text/csv,text/tab-separated-values" aria-label="After CSV file"></label></div>
<div class="config"><label>Delimiter<select id="delimiter"><option value=",">Comma</option><option value="tab">Tab</option></select></label><label>Match rows by<select id="key-select" disabled><option>Choose files first</option></select></label><label>Compare total of<select id="value-select" disabled><option>Choose files first</option></select></label><button id="compare" class="primary" disabled>Explain change</button></div>
<p class="input-note">Files stay in your browser. UTF-8 CSV / TSV, up to 20 MiB each. Use the CLI for composite keys.</p>
<p id="error" role="alert" hidden></p><p id="file-status" class="input-note" role="status" aria-live="polite"></p>
</section>
<section id="report" aria-label="Comparison report">
<div class="report-heading"><div><span id="sample-badge" class="badge">SAMPLE DATA</span><span id="report-source"></span></div><span class="verified"><span aria-hidden="true">✓</span> <span id="reconcile-status">Totals reconcile exactly</span></span></div>
<div class="metrics"><div class="metric"><span>Before total</span><strong id="total-before"></strong><small id="count-before"></small></div><div class="metric"><span>After total</span><strong id="total-after"></strong><small id="count-after"></small></div><div class="metric focus"><span>Net change</span><strong id="total-delta"></strong><small id="percent-change"></small></div></div>
<div class="analysis-grid"><section class="chart-panel"><div class="section-heading"><div><h2>How the total changed</h2><p>Click a contribution to inspect its rows.</p></div><span id="metric-label" class="mono"></span></div><div id="waterfall"></div><div id="equation" class="equation"></div></section><aside class="drivers"><p class="eyebrow">LOOK CLOSER</p><h2>The largest movements</h2><p class="aside-note">Arithmetic contributors, not business causes.</p><div id="drivers"></div></aside></div>
<section class="rows-panel"><div class="section-heading"><div><h2>The rows behind the numbers <span id="row-total" class="count-tag"></span></h2><p id="scope-note"></p></div><button id="export-json" class="text-button">Export JSON ↓</button></div><div class="table-tools"><div id="filters" class="filters" role="group" aria-label="Filter by change type"></div><label class="search-label"><span class="sr-only">Search row keys</span><input id="search" type="search" placeholder="Search row keys…"></label></div><div class="table-wrap"><table><thead><tr><th id="key-heading" scope="col">Row key</th><th scope="col">Status</th><th scope="col" class="number">Before</th><th scope="col" class="number">After</th><th scope="col" class="number">Contribution</th></tr></thead><tbody id="rows"></tbody></table></div><div class="pagination"><span id="page-note" aria-live="polite"></span><div><button id="prev-page" aria-label="Previous page">← Previous</button><button id="next-page" aria-label="Next page">Next →</button></div></div></section>
<section class="method"><h2>A small, checkable calculation.</h2><p>Before + added rows − removed rows + changes to matched values = after. Keys match exactly, including case and whitespace. Duplicate or empty keys and invalid numbers stop the comparison. Decimal totals use integer arithmetic; chart positions are approximate.</p><p id="schema-note"></p><p>Only the selected key columns and metric are included in the saved report. The report contains those values: review them before sharing. Rowglass makes no network requests and does not collect usage data.</p></section>
</section><footer><span class="brand-small">≋ rowglass</span><span>Small files. Clear answers.</span><a class="source-link" href="https://github.com/kwakhyun/rowglass" target="_blank" rel="noopener noreferrer">GitHub ↗ · MIT · v0.1.0</a></footer>
</main><dialog id="row-dialog"><button id="close-dialog" class="dialog-close" aria-label="Close row details">×</button><p class="eyebrow">ROW EVIDENCE</p><h2 id="detail-key"></h2><div id="detail-values"></div><p id="detail-note"></p></dialog>
<script id="rowglass-data" type="application/json">${safeJSON(state)}</script>
<script type="module">${engine}\n${ui}</script></body></html>`;
}
