// This file is embedded after engine.mjs in a single browser module.
const $ = id => document.getElementById(id);
const initial = JSON.parse($('rowglass-data').textContent);
let report = initial.report;
let isSample = initial.sample;
let filter = 'changes';
let page = 0;
let loadRevision = 0;
const pageSize = 40;
const files = { before: null, after: null };
const parsed = { before: null, after: null };
const labels = { added: 'Added', removed: 'Removed', changed: 'Value changed', unchanged: 'Same value' };

function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function display(value, signed = false) {
  if (value === null) return '—';
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [whole, fraction] = raw.split('.');
  const sign = negative ? '−' : signed && !/^0(?:\.0+)?$/.test(value) ? '+' : '';
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}
function units(value) { return BigInt(value.replace('.', '')); }
function absolute(value) { const n = units(value); return n < 0n ? -n : n; }
function direction(value) { return units(value) < 0n ? 'negative' : units(value) > 0n ? 'positive' : ''; }
function byImpact(a, b) {
  const aa = absolute(a.delta), bb = absolute(b.delta);
  return aa > bb ? -1 : aa < bb ? 1 : a.key.join(' / ').localeCompare(b.key.join(' / '));
}
function setError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function keyLabel(row) { return row.key.length === 1 ? row.key[0] : JSON.stringify(row.key); }
function signedPercent() {
  const base = units(report.totals.before), delta = units(report.totals.delta);
  if (base === 0n) return delta === 0n ? 'No change; baseline is zero' : 'No percentage: baseline is zero';
  if (base < 0n) return 'Percentage omitted for a negative baseline';
  const magnitude = delta < 0n ? -delta : delta;
  const roundedTenths = (magnitude * 1000n + base / 2n) / base;
  return `${delta < 0n ? '−' : delta > 0n ? '+' : ''}${roundedTenths / 10n}.${roundedTenths % 10n}% from before`;
}

function render() {
  $('row-dialog').close();
  $('detail-key').textContent = '';
  $('detail-values').replaceChildren();
  $('detail-note').textContent = '';
  $('sample-badge').hidden = !isSample;
  $('report-source').textContent = `${report.beforeName} → ${report.afterName}`;
  $('metric-label').textContent = report.value;
  $('total-before').textContent = display(report.totals.before);
  $('total-after').textContent = display(report.totals.after);
  $('total-delta').textContent = display(report.totals.delta, true);
  $('total-delta').className = direction(report.totals.delta);
  $('count-before').textContent = `${report.counts.before.toLocaleString()} rows · ${report.value}`;
  $('count-after').textContent = `${report.counts.after.toLocaleString()} rows · ${report.value}`;
  $('percent-change').textContent = signedPercent();
  $('scope-note').textContent = `Matched by ${report.keys.join(' + ')}. “Value changed” refers only to ${report.value}.`;
  $('row-total').textContent = report.rows.length.toLocaleString();
  $('key-heading').textContent = report.keys.join(' + ');
  $('schema-note').textContent = report.schema.added.length || report.schema.removed.length
    ? `Schema changes: added columns: ${report.schema.added.join(', ') || 'none'}; removed columns: ${report.schema.removed.join(', ') || 'none'}. Non-metric cell changes are outside this comparison.`
    : 'Non-metric cell changes are outside this comparison. Row order does not affect the result.';
  const term = v => units(v) === 0n ? `+${display(v)}` : display(v, true);
  $('equation').textContent = `${display(report.totals.before)} ${term(report.totals.added)} ${term(report.totals.removed)} ${term(report.totals.changed)} = ${display(report.totals.after)}`;
  drawWaterfall();
  const drivers = [...report.rows].filter(r => units(r.delta) !== 0n).sort(byImpact).slice(0, 3);
  $('drivers').replaceChildren();
  if (!drivers.length) $('drivers').append(element('p', 'No non-zero row contributions.', 'aside-note'));
  for (const row of drivers) {
    const button = element('button', undefined, 'driver');
    button.append(element('strong', keyLabel(row)), element('span', display(row.delta, true), direction(row.delta)), element('small', `${labels[row.status]} · ${display(row.before)} → ${display(row.after)}`));
    button.addEventListener('click', () => showRow(row));
    $('drivers').append(button);
  }
  renderRows();
}

function renderRows() {
  const counts = report.counts;
  const filters = [ ['changes', 'Changes', counts.added + counts.removed + counts.changed], ['added', 'Added', counts.added], ['removed', 'Removed', counts.removed], ['changed', 'Value changed', counts.changed], ['all', 'All', report.rows.length] ];
  $('filters').replaceChildren();
  for (const [value, label, count] of filters) {
    const b = element('button', label, filter === value ? 'active' : '');
    b.append(element('span', String(count)));
    b.setAttribute('aria-pressed', String(filter === value));
    b.addEventListener('click', () => selectFilter(value));
    $('filters').append(b);
  }
  const query = $('search').value.toLocaleLowerCase();
  const selected = report.rows.filter(r => (filter === 'all' || filter === 'changes' && r.status !== 'unchanged' || r.status === filter) && keyLabel(r).toLocaleLowerCase().includes(query)).sort(byImpact);
  const pageCount = Math.max(1, Math.ceil(selected.length / pageSize));
  page = Math.min(page, pageCount - 1);
  $('rows').replaceChildren();
  for (const row of selected.slice(page * pageSize, (page + 1) * pageSize)) {
    const tr = element('tr');
    const keyCell = element('td');
    const b = element('button', keyLabel(row), 'key-button');
    b.setAttribute('aria-label', `Inspect row ${keyLabel(row)}`);
    b.addEventListener('click', () => showRow(row));
    keyCell.append(b);
    const statusCell = element('td');
    statusCell.append(element('span', labels[row.status], `status-pill ${row.status}`));
    tr.append(keyCell, statusCell, element('td', display(row.before), 'number'), element('td', display(row.after), 'number'), element('td', display(row.delta, true), `number ${direction(row.delta)}`));
    $('rows').append(tr);
  }
  if (!selected.length) { const tr = element('tr'); const td = element('td', 'No rows match this view.', 'empty'); td.colSpan = 5; tr.append(td); $('rows').append(tr); }
  $('page-note').textContent = `${selected.length ? page * pageSize + 1 : 0}–${Math.min((page + 1) * pageSize, selected.length)} of ${selected.length.toLocaleString()} rows · largest impact first`;
  $('prev-page').disabled = page === 0;
  $('next-page').disabled = page >= pageCount - 1;
}
function selectFilter(value, scroll = false) {
  filter = value; page = 0; renderRows();
  if (scroll) $('filters').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function svgNode(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs || {})) n.setAttribute(key, String(value));
  if (text !== undefined) n.textContent = text;
  return n;
}
function drawWaterfall() {
  const t = report.totals;
  const n = key => Number(t[key]);
  const addedEnd = n('before') + n('added'), removedEnd = addedEnd + n('removed');
  const bars = [
    { label: 'Before', from: 0, to: n('before'), exact: t.before },
    { label: 'Added', from: n('before'), to: addedEnd, exact: t.added, filter: 'added' },
    { label: 'Removed', from: addedEnd, to: removedEnd, exact: t.removed, filter: 'removed' },
    { label: 'Value changed', from: removedEnd, to: n('after'), exact: t.changed, filter: 'changed' },
    { label: 'After', from: 0, to: n('after'), exact: t.after },
  ];
  const min = Math.min(0, ...bars.flatMap(b => [b.from, b.to]));
  const max = Math.max(0, ...bars.flatMap(b => [b.from, b.to]));
  const range = max - min || 1;
  const y = value => 200 - (value - min) / range * 154;
  const svg = svgNode('svg', { viewBox: '0 0 660 254', role: 'img', 'aria-label': `Total changed from ${t.before} to ${t.after}. Added ${t.added}, removed contribution ${t.removed}, matched value changes ${t.changed}.` });
  svg.append(svgNode('line', { x1: 22, x2: 640, y1: y(0), y2: y(0), stroke: '#dce2d8', 'stroke-width': 1 }));
  bars.forEach((bar, i) => {
    const x = 37 + i * 127, width = 80;
    const top = Math.min(y(bar.from), y(bar.to));
    const height = Math.max(2, Math.abs(y(bar.from) - y(bar.to)));
    const color = bar.filter ? units(bar.exact) < 0n ? '#bd7151' : '#6b9272' : '#233e31';
    const g = svgNode('g', bar.filter ? { class: 'chart-bar', role: 'button', tabindex: 0, 'aria-label': `${bar.label}: ${display(bar.exact, true)}. Show rows.` } : {});
    g.append(svgNode('rect', { x, y: top, width, height, fill: color, rx: 3 }));
    const exact = display(bar.exact, !!bar.filter);
    const valueText = exact.length <= 16 ? exact : Number(bar.exact).toExponential(2);
    g.append(svgNode('text', { x: x + width / 2, y: top - 10, 'text-anchor': 'middle', fill: '#263e2f', 'font-size': 12, 'font-weight': 550 }, valueText));
    g.append(svgNode('text', { x: x + width / 2, y: 232, 'text-anchor': 'middle', fill: '#65746c', 'font-size': 11 }, bar.label));
    g.append(svgNode('title', {}, `${bar.label}: ${exact}`));
    if (bar.filter) {
      g.addEventListener('click', () => selectFilter(bar.filter, true));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFilter(bar.filter, true); } });
    }
    svg.append(g);
    if (i > 0 && i < 4) svg.append(svgNode('line', { x1: x + width, x2: x + 127, y1: y(bar.to), y2: y(bar.to), stroke: '#c1cbbf', 'stroke-dasharray': '3 3' }));
  });
  $('waterfall').replaceChildren(svg);
}
function showRow(row) {
  $('detail-key').textContent = keyLabel(row);
  $('detail-values').replaceChildren();
  for (const [label, value] of [[report.beforeName, display(row.before)], [report.afterName, display(row.after)], ['Contribution to total change', display(row.delta, true)]]) {
    const line = element('div', undefined, 'detail-item');
    line.append(element('span', label), element('strong', value));
    $('detail-values').append(line);
  }
  $('detail-note').textContent = row.status === 'added' ? 'This key exists only in the after file. Its entire value contributes to the total change.' : row.status === 'removed' ? 'This key exists only in the before file. Its contribution is the negative of its original value.' : `After minus before for ${report.value}. Other fields are not compared. This is an arithmetic explanation, not a business-cause inference.`;
  $('row-dialog').showModal();
}

async function loadFiles() {
  const revision = ++loadRevision;
  setError();
  $('compare').disabled = true;
  $('key-select').disabled = true;
  $('value-select').disabled = true;
  if (!files.before || !files.after) { $('file-status').textContent = 'Choose both files to configure your comparison. The report below is unchanged.'; return; }
  $('file-status').textContent = 'Reading files locally… The report below is unchanged until you compare.';
  try {
    const delimiter = $('delimiter').value === 'tab' ? '\t' : ',';
    const datasets = await Promise.all(['before', 'after'].map(async side => {
      const file = files[side];
      if (file.size > 20 * 1024 * 1024) throw new Error(`${side}: file exceeds the 20 MiB limit.`);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      return parseCSV(text, { delimiter });
    }));
    if (revision !== loadRevision) return;
    [parsed.before, parsed.after] = datasets;
    const common = parsed.before.headers.filter(h => parsed.after.headers.includes(h));
    if (common.length < 2) throw new Error('The files need at least two shared columns: one key and one numeric metric.');
    for (const id of ['key-select', 'value-select']) {
      const select = $(id); select.replaceChildren();
      for (const header of common) { const option = element('option', header); option.value = header; select.append(option); }
      select.disabled = false;
    }
    $('key-select').value = common.find(h => /^(id|account|name|key)$/i.test(h)) || common[0];
    $('value-select').value = common.find(h => /^(amount|revenue|cost|total|value|usage)$/i.test(h) && h !== $('key-select').value) || common.find(h => h !== $('key-select').value);
    $('compare').disabled = false;
    $('file-status').textContent = 'Files ready. Confirm the key and metric, then select “Explain change”.';
  } catch (e) { if (revision === loadRevision) { setError(e.message); $('file-status').textContent = 'The report below is unchanged.'; } }
}
for (const side of ['before', 'after']) $(side + '-file').addEventListener('change', e => {
  files[side] = e.target.files[0] || null;
  $(side + '-file-label').textContent = files[side]?.name || 'Choose a CSV file';
  loadFiles();
});
$('delimiter').addEventListener('change', loadFiles);
$('compare').addEventListener('click', () => {
  try {
    setError();
    if ($('key-select').value === $('value-select').value) throw new Error('Choose different columns for the row key and numeric metric.');
    report = reconcile(parsed.before, parsed.after, { keys: [$('key-select').value], value: $('value-select').value, beforeName: files.before.name, afterName: files.after.name });
    isSample = false; filter = 'changes'; page = 0; $('search').value = '';
    $('file-status').textContent = 'Comparison ready. Save report to keep an offline copy with these values.';
    render();
  } catch (e) { setError(e.message); $('file-status').textContent = 'Comparison failed. The report below is unchanged.'; }
});
$('sample-button').addEventListener('click', () => {
  ++loadRevision;
  for (const side of ['before', 'after']) { files[side] = null; parsed[side] = null; $(side + '-file').value = ''; $(side + '-file-label').textContent = 'Choose a CSV file'; }
  $('compare').disabled = true; $('key-select').disabled = true; $('value-select').disabled = true;
  report = initial.example; isSample = true; filter = 'changes'; page = 0; $('search').value = ''; setError(); $('file-status').textContent = ''; render();
});
$('search').addEventListener('input', () => { page = 0; renderRows(); });
$('prev-page').addEventListener('click', () => { page--; renderRows(); });
$('next-page').addEventListener('click', () => { page++; renderRows(); });
$('close-dialog').addEventListener('click', () => $('row-dialog').close());

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = element('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function encodeState(value) { return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); }
$('export-json').addEventListener('click', () => download(JSON.stringify(report, null, 2), 'rowglass-report.json', 'application/json'));
$('export-html').addEventListener('click', () => {
  const copy = document.documentElement.cloneNode(true);
  copy.querySelector('#rowglass-data').textContent = encodeState({ report, sample: isSample, example: initial.example });
  copy.querySelector('#row-dialog').removeAttribute('open');
  copy.querySelector('#detail-key').textContent = '';
  copy.querySelector('#detail-values').replaceChildren();
  copy.querySelector('#detail-note').textContent = '';
  // File selections cannot be restored. Reset that workspace while keeping the report.
  for (const side of ['before', 'after']) copy.querySelector('#' + side + '-file-label').textContent = 'Choose a CSV file';
  for (const id of ['key-select', 'value-select']) {
    const select = copy.querySelector('#' + id); select.replaceChildren(element('option', 'Choose files first')); select.disabled = true;
  }
  copy.querySelector('#compare').disabled = true;
  copy.querySelector('#error').hidden = true; copy.querySelector('#error').textContent = '';
  copy.querySelector('#file-status').textContent = '';
  copy.querySelector('#search').removeAttribute('value');
  download('<!doctype html>\n' + copy.outerHTML, 'rowglass-report.html', 'text/html');
});
render();
