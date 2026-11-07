// Embedded after engine.mjs in a single browser module; no external requests.
const $ = id => document.getElementById(id);
const initial = JSON.parse($('rowglass-data').textContent);
let report = initial.report;
let isSample = initial.sample;
let generatedAt = initial.generatedAt || null;
let filter = 'changes';
let sort = 'impact';
let page = 0;
let loadRevision = 0;
let loading = false;
let draftDirty = false;
let draftMapping = { keys: [], value: '' };
const exportIds = ['export-html', 'export-json', 'export-csv', 'export-markdown', 'copy-markdown'];
let toastTimer;
const pageSize = 40;
const sides = ['before', 'after'];
const files = { before: null, after: null };
const parsed = { before: null, after: null };
const labels = { added: 'Added', removed: 'Removed', changed: 'Value changed', unchanged: 'Same value' };
const filterNames = { changes: 'Changes', added: 'Added', removed: 'Removed', changed: 'Value changed', all: 'All rows' };
const sortNames = { impact: 'largest impact first', key: 'key order', increase: 'largest increase first', decrease: 'largest decrease first' };
const delimiterNames = { ',': 'comma', '\t': 'tab', ';': 'semicolon' };
const filterButtons = new Map();
let rowFacts = new WeakMap();
let sortedCache = new Map();
let selectionCache = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function display(value, signed = false) {
  if (value === null) return '—';
  const negative = value.startsWith('-');
  const [whole, fraction] = (negative ? value.slice(1) : value).split('.');
  const sign = negative ? '−' : signed && !/^0(?:\.0+)?$/.test(value) ? '+' : '';
  return sign + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : `.${fraction}`);
}
function units(value) { return BigInt(value.replace('.', '')); }
function absolute(value) { const n = typeof value === 'bigint' ? value : units(value); return n < 0n ? -n : n; }
function direction(value) { const n = units(value); return n < 0n ? 'negative' : n > 0n ? 'positive' : ''; }
function keyLabel(row) { return row.key.join(' / '); }
function reportNoun() { return report.aggregation === 'sum' ? 'group' : 'row'; }
function reportCount(count) { return countLabel(count, reportNoun()); }
function countLabel(count, noun = 'row') { return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`; }
function setDirection(node, value) {
  node.classList.remove('positive', 'negative');
  const className = direction(value);
  if (className) node.classList.add(className);
}
function motion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
function scrollToRows() {
  $('rows-label').scrollIntoView({ behavior: motion(), block: 'start' });
}
// quoteCell (engine) shortens long text and escapes invisible characters.
function quoted(key) { return quoteCell(Array.isArray(key) ? key.join(' / ') : String(key)); }
// Engine messages quote source text; classify them without it, so a cell cannot choose the hint.
function errorShape(message) { return String(message).replace(/"(?:[^"\\]|\\.)*"/g, '""'); }
function actionButton(label, run) {
  const button = element('button', label, 'button secondary small');
  button.type = 'button';
  button.addEventListener('click', run);
  return button;
}
function focusReport() {
  requestAnimationFrame(() => {
    $('report-title').focus({ preventScroll: true });
    $('report-title').scrollIntoView({ behavior: 'auto', block: 'start' });
  });
}
// reveal: 'scroll' brings the message into view; 'focus' also moves focus to it.
function setError(message = '', actions = [], reveal = '') {
  $('error-text').textContent = message;
  $('error-actions').replaceChildren(...actions.map(action => actionButton(action.label, action.run)));
  $('error-actions').hidden = !actions.length;
  $('error').hidden = !message;
  // The error box then carries the fix buttons, so the column check does not repeat them.
  $('mapping-check').classList.toggle('has-error-actions', !!message && actions.length > 0);
  if (!message || !reveal) return;
  requestAnimationFrame(() => {
    $('error').scrollIntoView({ behavior: motion(), block: 'center' });
    if (reveal === 'focus') $('error').focus({ preventScroll: true });
  });
}
function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  $('toast').classList.add('is-visible');
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
    $('toast').classList.remove('is-visible');
    $('toast').textContent = '';
  }, 5500);
}
function exportScopeText() {
  const changedCount = report.counts.added + report.counts.removed + report.counts.changed;
  return `CSV: all ${reportCount(changedCount)} with changes. Markdown: top 10 changes. JSON: all ${reportCount(report.rows.length)}. Table filters do not affect exports.`;
}
function setDirty(value) {
  draftDirty = value;
  $('draft-notice').hidden = !value;
  for (const id of exportIds) $(id).disabled = value;
  // Disabled buttons cannot explain themselves, so the scope notes carry the reason.
  $('export-scope').textContent = value ? 'Apply or discard your draft to download this report.' : `Includes all ${reportCount(report.rows.length)}, even when filtered.`;
  $('data-export-scope').textContent = value ? 'Apply or discard your draft to export.' : exportScopeText();
}
function setBusy(value) {
  loading = value;
  $('comparison-form').setAttribute('aria-busy', String(value));
  for (const side of sides) $(side + '-drop').setAttribute('aria-busy', String(value && !!files[side]));
  $('compare').disabled = value || !parsed.before || !parsed.after || $('key-select').disabled || !$('key-select').value || !$('value-select').value;
  $('swap-files').disabled = !files.before && !files.after;
}
function draftHint(prefix) {
  return `${prefix}${draftDirty ? ' Draft changes are not in the report yet.' : ''}`;
}

function signedPercent() {
  const base = units(report.totals.before), delta = units(report.totals.delta);
  if (base === 0n) return delta === 0n ? 'No change; baseline is zero' : 'Percentage unavailable: baseline is zero';
  if (base < 0n) return 'Percentage omitted for a negative baseline';
  const tenths = (absolute(delta) * 1000n + base / 2n) / base;
  return `${delta < 0n ? '−' : delta > 0n ? '+' : ''}${tenths / 10n}.${tenths % 10n}% from before`;
}
function prepareRows() {
  rowFacts = new WeakMap();
  sortedCache = new Map();
  selectionCache = null;
  report.rows.forEach((row, index) => {
    const key = keyLabel(row), delta = units(row.delta);
    rowFacts.set(row, { key, query: key.toLocaleLowerCase(), delta, magnitude: absolute(delta), index });
  });
}
function sortedRows() {
  if (sortedCache.has(sort)) return sortedCache.get(sort);
  const result = [...report.rows].sort((a, b) => {
    const aa = rowFacts.get(a), bb = rowFacts.get(b);
    if (sort === 'impact' && aa.magnitude !== bb.magnitude) return aa.magnitude > bb.magnitude ? -1 : 1;
    if (sort === 'increase' && aa.delta !== bb.delta) return aa.delta > bb.delta ? -1 : 1;
    if (sort === 'decrease' && aa.delta !== bb.delta) return aa.delta < bb.delta ? -1 : 1;
    return aa.key.localeCompare(bb.key) || aa.index - bb.index;
  });
  sortedCache.set(sort, result);
  return result;
}
function selectedRows() {
  const query = $('search').value.toLocaleLowerCase();
  if (selectionCache?.sort === sort && selectionCache.filter === filter && selectionCache.query === query) return selectionCache.rows;
  const rows = sortedRows().filter(row => (
    filter === 'all' || (filter === 'changes' && row.status !== 'unchanged') || row.status === filter
  ) && rowFacts.get(row).query.includes(query));
  selectionCache = { sort, filter, query, rows };
  return rows;
}
function initializeFilters() {
  $('filters').replaceChildren();
  for (const [value, label] of Object.entries(filterNames)) {
    const button = element('button', undefined, 'filter-chip');
    button.type = 'button';
    button.dataset.filter = value;
    const count = element('span', '', 'filter-count');
    button.append(element('span', label), count);
    button.addEventListener('click', () => selectFilter(value));
    filterButtons.set(value, { button, count });
    $('filters').append(button);
  }
}
function updateFilters() {
  const counts = {
    changes: report.counts.added + report.counts.removed + report.counts.changed,
    added: report.counts.added, removed: report.counts.removed, changed: report.counts.changed,
    all: report.rows.length,
  };
  for (const [value, { button, count }] of filterButtons) {
    button.firstElementChild.textContent = value === 'all' ? `All ${reportNoun()}s` : filterNames[value];
    count.textContent = counts[value].toLocaleString();
    button.classList.toggle('active', filter === value);
    button.setAttribute('aria-pressed', String(filter === value));
  }
  for (const status of ['added', 'removed', 'changed']) {
    $('contrib-' + status).setAttribute('aria-pressed', String(filter === status));
  }
}
function selectFilter(value, scroll = false) {
  filter = value;
  page = 0;
  renderRows();
  if (scroll) scrollToRows();
}
function resetView() {
  filter = 'changes'; sort = 'impact'; page = 0;
  $('search').value = '';
  $('row-sort').value = 'impact';
}
function tableCell(label, header, text, className) {
  const cell = element('td', text, className);
  cell.dataset.label = label;
  cell.setAttribute('headers', header);
  return cell;
}
function renderRows() {
  updateFilters();
  const selected = selectedRows();
  const pageCount = Math.max(1, Math.ceil(selected.length / pageSize));
  page = Math.max(0, Math.min(page, pageCount - 1));
  const fragment = document.createDocumentFragment();
  for (const row of selected.slice(page * pageSize, (page + 1) * pageSize)) {
    const tr = element('tr');
    tr.dataset.status = row.status;
    const keyCell = tableCell(report.keys.join(' + '), 'key-heading');
    const button = element('button', rowFacts.get(row).key, 'key-button');
    button.type = 'button';
    button.setAttribute('aria-label', `Inspect ${reportNoun()} ${rowFacts.get(row).key}`);
    button.addEventListener('click', () => showRow(row));
    keyCell.append(button);
    const statusCell = tableCell('Status', 'status-heading');
    statusCell.append(element('span', labels[row.status], `status-pill ${row.status}`));
    tr.append(
      keyCell, statusCell,
      tableCell('Before', 'before-heading', display(row.before), 'number'),
      tableCell('After', 'after-heading', display(row.after), 'number'),
      tableCell('Contribution', 'contribution-heading', display(row.delta, true), `number ${direction(row.delta)}`),
    );
    fragment.append(tr);
  }
  $('rows').replaceChildren(fragment);
  $('empty-state').hidden = selected.length !== 0;
  const noChanges = filter === 'changes' && !$('search').value && report.counts.added + report.counts.removed + report.counts.changed === 0;
  $('empty-title').textContent = noChanges ? `No ${reportNoun()} changes` : 'No matching rows';
  $('empty-description').textContent = noChanges ? `The selected values match. Choose All ${reportNoun()}s to inspect them.` : 'Try a different search or reset the filters.';
  $('clear-search').hidden = $('search').value.length === 0;
  const first = selected.length ? page * pageSize + 1 : 0;
  const last = Math.min((page + 1) * pageSize, selected.length);
  $('page-note').textContent = `${first.toLocaleString()}–${last.toLocaleString()} of ${reportCount(selected.length)}; ${sortNames[sort]}`;
  $('prev-page').disabled = page === 0;
  $('next-page').disabled = page >= pageCount - 1;
}

function renderDrivers() {
  let increase = null, decrease = null;
  for (const row of report.rows) {
    const delta = rowFacts.get(row).delta;
    if (delta > 0n && (!increase || delta > rowFacts.get(increase).delta)) increase = row;
    if (delta < 0n && (!decrease || delta < rowFacts.get(decrease).delta)) decrease = row;
  }
  $('drivers').replaceChildren();
  for (const [label, row] of [['Largest increase', increase], ['Largest decrease', decrease]]) {
    if (!row) continue;
    const button = element('button', undefined, `driver ${direction(row.delta)}`);
    button.type = 'button';
    button.setAttribute('aria-label', `${label}: ${keyLabel(row)}, ${display(row.delta, true)}. Inspect ${reportNoun()}.`);
    button.append(
      element('span', label, 'driver-label'),
      element('strong', keyLabel(row), 'driver-key'),
      element('span', display(row.delta, true), 'driver-amount'),
      element('small', `${labels[row.status]}: ${display(row.before)} → ${display(row.after)}`, 'driver-meta'),
    );
    button.addEventListener('click', () => showRow(row));
    $('drivers').append(button);
  }
  if (!increase && !decrease) $('drivers').append(element('p', `No ${reportNoun()}s have a nonzero contribution to the total.`, 'aside-note'));
}
// Gross movement shows how much offsetting hides behind the net change.
function renderMovement(movement) {
  const summary = $('drivers-summary');
  summary.hidden = movement.moving === 0;
  if (!movement.moving) { summary.textContent = ''; return; }
  const gross = `Gross movement ${display(movement.gross)} across ${reportCount(movement.moving)}, against a net change of ${display(report.totals.delta, true)}.`;
  summary.textContent = movement.largest.count < movement.moving
    ? `${gross} The ${movement.largest.count} largest make up ${movement.largest.percent === '0.0' ? 'under 0.1' : movement.largest.percent}% of it.`
    : gross;
}
function notice(text) {
  const node = element('p', text, 'report-notice');
  return node;
}
function renderNotices() {
  const notices = [];
  const similar = findSimilarKeys(report);
  if (similar.count) {
    const [first] = similar.examples;
    notices.push(notice(`Possible key mismatch: ${countLabel(similar.count, `added ${reportNoun()}`)} ${similar.count === 1 ? 'matches a removed one' : 'match removed ones'} except for letter case, spacing, character width, or Unicode form (such as decomposed Hangul), e.g. ${quoted(first.removed)} → ${quoted(first.added)}. Keys are matched exactly, so each pair counts as one removal and one addition. Fix the source keys if they name the same thing.`));
  }
  const { added, removed } = report.schema;
  if (added.length || removed.length) {
    const list = names => names.map(quoted).join(', ');
    const changes = [added.length ? `adds ${list(added)}` : '', removed.length ? `drops ${list(removed)}` : ''].filter(Boolean).join(' and ');
    notices.push(notice(`Columns differ between the files: the after file ${changes}. Only ${quoted(report.value)} is compared.`));
  }
  $('report-notices').replaceChildren(...notices);
}
function renderIdentity() {
  document.title = isSample ? 'Rowglass — Your totals, explained' : `${report.beforeName} → ${report.afterName} · Rowglass`;
  const node = $('generated-at');
  const date = generatedAt && !isSample ? new Date(generatedAt) : null;
  node.hidden = !date || Number.isNaN(date.getTime());
  node.textContent = node.hidden ? '' : `Compared ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  if (node.hidden) node.removeAttribute('title'); else node.title = generatedAt;
}
function renderReport() {
  clearDetails(true);
  prepareRows();
  const changedCount = report.counts.added + report.counts.removed + report.counts.changed;
  const grouped = report.aggregation === 'sum';
  $('rows-title').textContent = grouped ? 'Groups behind the change' : 'Rows behind the change';
  $('breakdown-help').textContent = `Select a change type to see its ${reportNoun()}s.`;
  $('drivers-hint').textContent = grouped ? 'Inspect a group and its source row counts' : 'Follow a row to its original values';
  $('table-caption').textContent = `${grouped ? 'Grouped totals' : 'Individual row values'} and their contribution to the total change.`;
  $('search-label').textContent = `Search ${reportNoun()} keys`;
  $('sort-label').textContent = `Sort ${reportNoun()}s`;
  $('filters').setAttribute('aria-label', `Filter ${reportNoun()}s by change type`);
  $('close-dialog').setAttribute('aria-label', `Close ${reportNoun()} details`);
  $('search').placeholder = `Search ${reportNoun()}s`;
  $('export-csv').textContent = `Changed ${reportNoun()}s CSV`;
  $('aggregation-note').hidden = !grouped;
  $('aggregation-note').textContent = grouped ? `Group & sum by ${report.keys.join(' + ')}. Every selected metric value is included. Changes describe group totals; offsetting changes within a group can be hidden. Inspect a group to see its source row counts.` : '';
  $('sample-banner').hidden = !isSample;
  $('group-example-button').textContent = grouped ? 'Try customer totals' : 'Try line-item costs';
  $('report-kind').textContent = isSample ? 'Example report' : 'Your comparison';
  $('report-title').textContent = 'Your totals, explained.';
  $('summary-description').textContent = changedCount === 0
    ? `No ${reportNoun()}${grouped ? ' total' : ''} changes. The overall total is unchanged.`
    : units(report.totals.delta) === 0n
      ? `${reportCount(changedCount)} changed, with no net change to the total.`
      : `${reportCount(changedCount)} ${changedCount === 1 ? 'accounts' : 'account'} for this change in ${report.value}.`;
  $('before-name').textContent = report.beforeName;
  $('after-name').textContent = report.afterName;
  $('report-source').textContent = `${report.beforeName} → ${report.afterName}`;
  $('metric-label').textContent = report.value;
  $('key-summary').textContent = report.keys.join(' + ');
  $('row-change-count').textContent = `${reportCount(changedCount)} changed`;
  $('total-before').textContent = display(report.totals.before);
  $('total-after').textContent = display(report.totals.after);
  $('total-delta').textContent = display(report.totals.delta, true);
  setDirection($('total-delta'), report.totals.delta);
  for (const side of sides) $('count-' + side).textContent = grouped
    ? `${countLabel(report.sourceCounts[side])} → ${countLabel(report.counts[side], 'group')}`
    : countLabel(report.counts[side]);
  $('percent-change').textContent = signedPercent();
  $('scope-note').textContent = `${grouped ? 'Summed' : 'Matched'} by ${report.keys.join(' + ')}. “Value changed” refers only to ${grouped ? 'the group total of ' : ''}${report.value}.`;
  $('row-total').textContent = report.rows.length.toLocaleString();
  $('key-heading').textContent = report.keys.join(' + ');
  $('schema-note').textContent = report.schema.added.length || report.schema.removed.length
    ? `Column changes: added ${report.schema.added.join(', ') || 'none'}; removed ${report.schema.removed.join(', ') || 'none'}. Other cell values are not compared.`
    : 'Other cell values are not compared. Row order does not affect this result.';
  const statuses = ['added', 'removed', 'changed'];
  const maxContribution = statuses.reduce((largest, status) => {
    const amount = absolute(report.totals[status]);
    return amount > largest ? amount : largest;
  }, 0n);
  for (const status of statuses) {
    const value = report.totals[status];
    $(status + '-total').textContent = display(value, true);
    setDirection($(status + '-total'), value);
    $(status + '-count').textContent = reportCount(report.counts[status]);
    $(status + '-label').textContent = status === 'changed' ? (grouped ? 'Changed group totals' : 'Changed values') : `${status === 'added' ? 'Added' : 'Removed'} ${reportNoun()}s`;
    $(status + '-description').textContent = status === 'added' ? 'New in the after file' : status === 'removed' ? 'Only in the before file' : `Same ${reportNoun()}, different ${grouped ? 'total' : 'amount'}`;
    const width = maxContribution === 0n ? 0 : Number(absolute(value) * 10000n / maxContribution) / 100;
    $(status + '-bar').style.width = `${width}%`;
    $('contrib-' + status).setAttribute('aria-label', `${labels[status]}: ${display(value, true)} across ${reportCount(report.counts[status])}. Show ${reportNoun()}s.`);
  }
  // Net value changes can hide large offsetting edits, so show both directions.
  const movement = summarizeMovement(report);
  const split = $('changed-split');
  split.hidden = report.counts.changed === 0;
  split.replaceChildren();
  if (!split.hidden) {
    const part = (arrow, side, noun) => {
      const node = element('span', `${arrow}\u00a0${display(side.total, true)} `, side.count ? direction(side.total) : 'muted');
      node.append(element('small', countLabel(side.count, noun)));
      return node;
    };
    split.append(part('↑', movement.increased, 'increase'), part('↓', movement.decreased, 'decrease'));
    $('contrib-changed').setAttribute('aria-label', `${labels.changed}: ${display(report.totals.changed, true)} across ${reportCount(report.counts.changed)}: ${display(movement.increased.total, true)} from ${countLabel(movement.increased.count, 'increase')} and ${display(movement.decreased.total, true)} from ${countLabel(movement.decreased.count, 'decrease')}. Show ${reportNoun()}s.`);
  }
  const term = value => value.startsWith('-') ? `− ${display(value.slice(1))}` : `+ ${display(value)}`;
  $('equation').textContent = `${display(report.totals.before)} ${term(report.totals.added)} ${term(report.totals.removed)} ${term(report.totals.changed)} = ${display(report.totals.after)}`;
  drawWaterfall();
  renderDrivers();
  renderMovement(movement);
  renderNotices();
  renderIdentity();
  renderRows();
  setDirty(draftDirty);
}

function svgNode(tag, attributes, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes || {})) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function drawWaterfall() {
  const totals = report.totals;
  const before = units(totals.before), after = units(totals.after);
  const addedEnd = before + units(totals.added), removedEnd = addedEnd + units(totals.removed);
  // When every running total has the same sign and the changes are small next to
  // them, start the axis near the totals so the change bars stay visible.
  const points = [before, addedEnd, removedEnd, after];
  const low = points.reduce((a, b) => a < b ? a : b), high = points.reduce((a, b) => a > b ? a : b);
  const span = high - low;
  const base = span > 0n && low > 0n && low > span * 3n ? low - span * 2n
    : span > 0n && high < 0n && -high > span * 3n ? high + span * 2n
      : 0n;
  const bars = [
    { label: 'Before', from: base, to: before, exact: totals.before },
    { label: 'Added', from: before, to: addedEnd, exact: totals.added, filter: 'added' },
    { label: 'Removed', from: addedEnd, to: removedEnd, exact: totals.removed, filter: 'removed' },
    { label: 'Value changed', from: removedEnd, to: after, exact: totals.changed, filter: 'changed' },
    { label: 'After', from: base, to: after, exact: totals.after },
  ];
  const ends = [base, ...bars.flatMap(bar => [bar.from, bar.to])];
  const min = ends.reduce((a, b) => a < b ? a : b), max = ends.reduce((a, b) => a > b ? a : b);
  const range = max - min || 1n;
  // Only the chart geometry is approximate; arithmetic and labels stay exact.
  const y = value => 200 - Number((value - min) * 154000n / range) / 1000;
  const axisStart = display(formatDecimal(base, report.scale));
  const axisNote = base === 0n ? '' : `The axis starts at ${axisStart}, not zero, so the changes are easier to see. Before and after bars are shortened.`;
  $('chart-axis-note').hidden = !axisNote;
  $('chart-axis-note').textContent = axisNote;
  const svg = svgNode('svg', { viewBox: '0 0 660 254', role: 'group', 'aria-label': `Total changed from ${totals.before} to ${totals.after}. Added ${totals.added}, removed contribution ${totals.removed}, matched value changes ${totals.changed}.${axisNote ? ' ' + axisNote : ''}` });
  svg.append(svgNode('line', { x1: 22, x2: 640, y1: y(base), y2: y(base), stroke: '#d9dfe7', 'stroke-width': 1 }));
  bars.forEach((bar, index) => {
    const x = 37 + index * 127, width = 80;
    const top = Math.min(y(bar.from), y(bar.to));
    const height = Math.max(2, Math.abs(y(bar.from) - y(bar.to)));
    const color = bar.filter ? units(bar.exact) < 0n ? '#b45323' : '#2563eb' : '#4e5968';
    const group = svgNode('g', bar.filter ? { class: 'chart-bar', role: 'button', tabindex: 0, 'aria-label': `${bar.label}: ${display(bar.exact, true)}. Show rows.` } : {});
    group.append(svgNode('rect', { x, y: top, width, height, fill: color, rx: 3 }));
    if (base !== 0n && !bar.filter && height > 24) {
      // A zigzag break marks the shortened total bars.
      const breakY = base > 0n ? top + height - 12 : top + 12;
      group.append(svgNode('path', { d: `M${x - 2} ${breakY + 3} l${(width + 4) / 4} -6 l${(width + 4) / 4} 6 l${(width + 4) / 4} -6 l${(width + 4) / 4} 6`, stroke: '#ffffff', 'stroke-width': 3, fill: 'none' }));
    }
    const exact = display(bar.exact, !!bar.filter);
    group.append(svgNode('text', { x: x + width / 2, y: top - 10, 'text-anchor': 'middle', fill: '#6b7684', 'font-size': exact.length > 16 ? 9 : 12, 'font-weight': 550 }, exact.length > 22 ? `${exact.slice(0, 19)}…` : exact));
    group.append(svgNode('text', { x: x + width / 2, y: 232, 'text-anchor': 'middle', fill: '#6b7684', 'font-size': 11 }, bar.label));
    group.append(svgNode('title', {}, `${bar.label}: ${exact}`));
    if (bar.filter) {
      group.addEventListener('click', () => selectFilter(bar.filter, true));
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectFilter(bar.filter, true); }
      });
    }
    svg.append(group);
    if (index > 0 && index < 4) svg.append(svgNode('line', { x1: x + width, x2: x + 127, y1: y(bar.to), y2: y(bar.to), stroke: '#d9dfe7', 'stroke-dasharray': '3 3' }));
  });
  $('waterfall').replaceChildren(svg);
}

function clearDetails(close = false) {
  if (close && $('row-dialog').open) $('row-dialog').close();
  $('detail-key').textContent = '';
  $('detail-status').textContent = '';
  $('detail-status').classList.remove('added', 'removed', 'changed', 'unchanged');
  $('detail-status').classList.add('status-pill');
  $('detail-values').replaceChildren();
  $('detail-note').textContent = '';
}
function showRow(row) {
  clearDetails();
  $('detail-kind').textContent = report.aggregation === 'sum' ? 'Group details' : 'Row details';
  $('detail-key').textContent = keyLabel(row);
  $('detail-status').textContent = labels[row.status];
  $('detail-status').classList.add(row.status);
  if (report.keys.length > 1) {
    for (const [index, key] of report.keys.entries()) {
      const part = element('div', undefined, 'detail-item');
      part.append(element('span', key), element('strong', row.key[index]));
      $('detail-values').append(part);
    }
  }
  for (const [index, [label, value]] of [[report.beforeName, display(row.before)], [report.afterName, display(row.after)], ['Contribution to total change', display(row.delta, true)]].entries()) {
    const line = element('div', undefined, 'detail-item');
    const amount = element('strong', value);
    if (index === 2) setDirection(amount, row.delta);
    line.append(element('span', label), amount);
    $('detail-values').append(line);
  }
  if (report.aggregation === 'sum') {
    const sourceCount = element('div', undefined, 'group-source-counts');
    sourceCount.append(element('span', `${countLabel(row.beforeCount)} before`), element('span', `${countLabel(row.afterCount)} after`));
    $('detail-values').prepend(sourceCount);
  }
  $('detail-note').textContent = row.status === 'added'
    ? 'This key exists only in the after file. Its entire value contributes to the total change.'
    : row.status === 'removed'
      ? 'This key exists only in the before file. Its contribution is the negative of its original value.'
      : `After minus before for ${report.value}. Other fields are not compared. This describes the arithmetic, not the business cause.`;
  if (report.aggregation === 'sum') $('detail-note').textContent = `Sum of ${report.value} for this group. Individual source rows are not retained in the report. Internal changes can offset, so an unchanged group total does not mean its source rows are unchanged.`;
  $('row-dialog').showModal();
}

function clearMapping() {
  $('mapping-fields').hidden = true;
  $('extra-keys').replaceChildren();
  $('extra-keys-details').open = false;
  $('extra-key-summary').textContent = 'Add key columns';
  $('mapping-check').replaceChildren();
  for (const id of ['key-select', 'value-select']) {
    const option = element('option', 'Choose files first');
    option.value = '';
    $(id).replaceChildren(option);
    $(id).disabled = true;
  }
  for (const id of ['key-preview', 'value-preview']) {
    $(id).textContent = '';
    $(id).removeAttribute('title');
  }
  $('compare').disabled = true;
}
function updateFileLabels() {
  for (const side of sides) {
    $(side + '-file-label').textContent = files[side]?.name || 'Choose a CSV file';
    $(side + '-drop').classList.toggle('is-loaded', !!files[side]);
    $(side + '-drop').classList.remove('is-dragging', 'has-error');
    $(side + '-file').removeAttribute('aria-invalid');
    $(side + '-file-meta').textContent = files[side] ? 'Ready to read' : 'or drop a file here';
  }
}
function preview(dataset, column) {
  const index = dataset.headers.indexOf(column);
  if (index < 0 || !dataset.rows.length) return 'No data rows';
  return dataset.rows.slice(0, 3).map(row => {
    const value = row[index];
    return JSON.stringify(value.length > 60 ? value.slice(0, 57) + '…' : value);
  }).join(', ');
}
function updatePreviews() {
  if (!parsed.before || !parsed.after) return;
  for (const [selectId, previewId] of [['key-select', 'key-preview'], ['value-select', 'value-preview']]) {
    const column = $(selectId).value;
    const keys = selectedKeys();
    const describe = dataset => selectId === 'key-select' && keys.length > 1
      ? dataset.rows.slice(0, 2).map(row => JSON.stringify(keys.map(key => { const value = row[dataset.headers.indexOf(key)]; return value.length > 40 ? value.slice(0, 37) + '…' : value; }))).join(', ')
      : preview(dataset, column);
    const text = `Before: ${describe(parsed.before)}. After: ${describe(parsed.after)}.`;
    $(previewId).textContent = text;
    $(previewId).title = text;
  }
}
function selectedKeys() {
  return [$('key-select').value, ...Array.from($('extra-keys').querySelectorAll('input:checked'), input => input.value)].filter(Boolean);
}
function updateMode() {
  const grouped = $('comparison-mode').value === 'groups';
  $('key-label').textContent = grouped ? 'Group by' : 'Match rows by';
  $('key-help').textContent = grouped ? 'Rows sharing this key are summed before comparing.' : 'Choose columns that together identify one row.';
  $('mode-description').textContent = grouped
    ? 'Add every value within each selected key. Compare group totals, not individual source rows.'
    : 'Each selected key must identify one row. Duplicate keys stop the comparison.';
}
function mappingChanged(status = 'Mapping updated. Select “Compare files” to apply it.') {
  draftMapping = { keys: selectedKeys(), value: $('value-select').value };
  setDirty(true); setError(); updateKeySummary(); updatePreviews(); renderMappingCheck(); setBusy(false);
  $('file-status').textContent = draftHint(status);
}
function updateExtraKeys(wanted = selectedKeys()) {
  const primary = $('key-select').value, metric = $('value-select').value;
  const common = parsed.before?.headers.filter(header => parsed.after?.headers.includes(header)) || [];
  $('extra-keys').replaceChildren();
  for (const name of common.filter(name => name !== primary && name !== metric)) {
    const label = element('label', undefined, 'key-choice');
    const input = element('input'); input.type = 'checkbox'; input.value = name;
    input.checked = wanted.includes(name);
    input.addEventListener('change', () => mappingChanged());
    label.append(input, element('span', name)); $('extra-keys').append(label);
  }
  $('extra-keys-details').hidden = !common.some(name => name !== primary && name !== metric);
  updateKeySummary();
}
function updateKeySummary() {
  const count = selectedKeys().length;
  $('extra-key-summary').textContent = count > 1 ? `${count} key columns selected` : 'Add key columns';
}
// A column counts as numeric when its first 200 values on both sides are exact decimals.
function numericColumns(common) {
  return new Set(common.filter(header => sides.every(side => {
    const dataset = parsed[side], index = dataset.headers.indexOf(header);
    return dataset.rows.slice(0, 200).every(row => isExactDecimal(row[index]));
  })));
}
function setMapping(previousKeys, previousValue) {
  const common = parsed.before.headers.filter(header => parsed.after.headers.includes(header));
  if (common.length < 2) throw new Error('The files need at least two shared columns: keys and a numeric metric.');
  const numeric = numericColumns(common);
  const option = header => { const node = element('option', header); node.value = header; return node; };
  for (const id of ['key-select', 'value-select']) {
    const select = $(id); select.replaceChildren();
    const placeholder = element('option', 'Choose a column'); placeholder.value = ''; select.append(placeholder);
    if (id === 'value-select' && numeric.size && numeric.size < common.length) {
      for (const [label, headers] of [['Numeric columns', common.filter(header => numeric.has(header))], ['Other columns', common.filter(header => !numeric.has(header))]]) {
        const group = element('optgroup'); group.label = label;
        group.append(...headers.map(option));
        select.append(group);
      }
    } else {
      select.append(...common.map(option));
    }
    select.disabled = false;
  }
  const missingKeys = previousKeys.some(key => !common.includes(key));
  const keyPattern = /^(id|account|customer|client|name|key|code|sku|계정|고객|고객명|거래처|이름|코드|품목)$/i;
  // Identifier names such as order_id, Invoice No, or 거래처코드 are often numeric, so check them before text columns.
  const idPattern = header => /(^|[_\s.-])(id|no|num|number|code|key|sku)$|(번호|코드|아이디)$/i.test(header) || /[a-z](Id|ID)$/.test(header);
  const valuePattern = /^(amount|revenue|sales|cost|total|value|usage|price|금액|매출|비용|합계|사용량)$/i;
  $('key-select').value = missingKeys ? ''
    : previousKeys[0] || common.find(header => keyPattern.test(header)) || common.find(idPattern)
      || common.find(header => !numeric.has(header)) || common[0];
  const key = $('key-select').value;
  // A named metric with a bad cell still wins, so the column check can point at that cell.
  $('value-select').value = previousValue ? (common.includes(previousValue) ? previousValue : '')
    : common.find(header => valuePattern.test(header) && numeric.has(header) && header !== key)
      || common.find(header => valuePattern.test(header) && header !== key)
      || common.find(header => numeric.has(header) && header !== key)
      || common.find(header => header !== key);
  updateExtraKeys(missingKeys ? [] : previousKeys);
  $('mapping-fields').hidden = false;
  updateMode(); updatePreviews(); renderMappingCheck();
  if (missingKeys || (previousValue && !common.includes(previousValue))) {
    setError('Previously selected columns are missing. Choose the keys and numeric column again; no replacement has been assumed.');
  }
}
function useGroupMode() {
  $('comparison-mode').value = 'groups';
  updateMode();
  mappingChanged('Switched to Group & sum. Select “Compare files” to apply it.');
  $('comparison-mode').focus();
}
function showExtraKeys() {
  $('extra-keys-details').open = true;
  ($('extra-keys').querySelector('input') || $('extra-keys-details').querySelector('summary')).focus();
}
function checkLine(tone, text, actions = []) {
  const line = element('div', undefined, `check-line ${tone}`);
  const mark = element('span', tone === 'ok' ? '✓' : tone === 'warn' ? '!' : 'i', 'check-mark');
  mark.setAttribute('aria-hidden', 'true');
  const paragraph = element('p');
  if (tone !== 'info') paragraph.append(element('span', tone === 'ok' ? 'OK: ' : 'Problem: ', 'sr-only'));
  paragraph.append(text);
  line.append(mark, paragraph);
  if (actions.length) {
    const group = element('div', undefined, 'check-actions');
    group.append(...actions.map(action => actionButton(action.label, action.run)));
    line.append(group);
  }
  return line;
}
// Preview the same validation that "Compare files" applies, before the user commits.
function renderMappingCheck() {
  const box = $('mapping-check');
  box.replaceChildren();
  if (!parsed.before || !parsed.after || $('key-select').disabled) return;
  const keys = selectedKeys(), value = $('value-select').value;
  if (!keys.length || !value) {
    box.append(checkLine('info', 'Choose the key columns and a numeric column to check both files.'));
    return;
  }
  if (keys.includes(value)) {
    box.append(checkLine('warn', `${quoted(value)} is selected as both a key and the column to total. Choose different columns.`));
    return;
  }
  const grouped = $('comparison-mode').value === 'groups';
  let duplicates = false;
  for (const side of sides) {
    const name = side === 'before' ? 'Before' : 'After';
    const scan = inspectMapping(parsed[side], { keys, value, aggregate: grouped });
    const problems = [];
    const verb = (count, one, many) => count === 1 ? one : many;
    if (scan.blankKeys.count) problems.push(`${countLabel(scan.blankKeys.count)} ${verb(scan.blankKeys.count, 'has', 'have')} a blank key, first at record ${scan.blankKeys.examples[0].record}`);
    if (scan.duplicateKeys.count) {
      duplicates = true;
      const first = scan.duplicateKeys.examples[0];
      problems.push(`${countLabel(scan.duplicateKeys.count)} ${verb(scan.duplicateKeys.count, 'repeats', 'repeat')} an earlier key, e.g. ${quoted(first.key)} at record ${first.record}`);
    }
    if (scan.invalidValues.count) {
      const first = scan.invalidValues.examples[0];
      problems.push(`${countLabel(scan.invalidValues.count, 'value')} in ${quoted(value)} ${verb(scan.invalidValues.count, 'is not a plain number', 'are not plain numbers')}, e.g. ${quoted(first.value)} at record ${first.record}`);
    }
    if (problems.length) {
      box.append(checkLine('warn', `${name}: ${problems.join('; ')}.`));
    } else {
      box.append(checkLine('ok', grouped
        ? `${name}: ${countLabel(scan.rows)} sum into ${countLabel(scan.keys, 'group')}; every value is a number.`
        : `${name}: ${countLabel(scan.keys, 'unique key')}; every value is a number.`));
    }
  }
  if (duplicates) {
    box.append(checkLine('info', 'Repeated keys need more key columns to identify each row, or Group & sum to compare totals per key.', [
      { label: 'Use Group & sum', run: useGroupMode },
      ...(!$('extra-keys-details').hidden ? [{ label: 'Add key columns', run: showExtraKeys }] : []),
    ]));
  }
}
function readError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const shape = errorShape(raw);
  const hint = /not valid UTF-8/i.test(shape)
    ? 'Files saved as “CSV” by Korean Excel use EUC-KR: read this file as Korean, or re-export it as “CSV UTF-8”.'
    : /byte order mark/.test(shape)
      ? 'Read this file as UTF-8.'
      : /not valid EUC-KR/i.test(shape)
        ? 'Read this file as UTF-8, or re-export it.'
        : /20 MiB|100,000 row/.test(shape)
          ? 'Use a smaller export within the file and row limits.'
          : /decimal|integer digit|decimal place/.test(shape)
            ? 'Choose a numeric column without blanks, currency symbols, separators, or surrounding spaces.'
            : /blank key/.test(shape)
              ? 'Fill in the blank keys in the source file; neither extra key columns nor Group & sum accept blank keys.'
              : /duplicate key/.test(shape)
                ? 'Add key columns to identify rows uniquely, or explicitly choose Group & sum to compare totals.'
                : /fields; expected/.test(shape)
                  ? 'Check the column separator under File format and limits.'
                  : /must contain a header row/.test(shape)
                    ? 'The file is empty. Choose the exported CSV file.'
                    : /empty header|duplicate header/.test(shape)
                      ? 'Give every column in the header row a unique, non-empty name.'
                      : 'Check the selected columns, file contents, and separator, then try again.';
  return `${raw} ${hint} The current report is unchanged.`;
}
async function readDataset(file, encoding) {
  if (file.size > MAX_TEXT_BYTES) throw new Error('File exceeds the 20 MiB limit.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error('File exceeds the 20 MiB limit.');
  return decodeText(buffer, encoding);
}
// Fix-it buttons disappear when the files reload, so keep keyboard focus in the dialog.
async function reloadKeepingFocus() {
  await loadFiles();
  if (!$('comparison-dialog').open || (document.activeElement && document.activeElement !== document.body)) return;
  (!$('error').hidden ? $('error') : !$('key-select').disabled ? $('key-select') : $('before-file')).focus({ preventScroll: true });
}
function setEncodings(list, encoding) {
  for (const side of list) $(side + '-encoding').value = encoding;
  setDirty(true);
  reloadKeepingFocus();
}
const detectSeparatorAction = { label: 'Detect the separator', run: () => { $('delimiter').value = 'auto'; setDirty(true); reloadKeepingFocus(); } };
const chooseSeparatorAction = { label: 'Choose the separator', run: () => { $('delimiter').closest('details').open = true; $('delimiter').focus(); } };
async function loadFiles(note = '') {
  const revision = ++loadRevision;
  const snapshot = { ...files };
  const choice = $('delimiter').value;
  const encodings = { before: $('before-encoding').value, after: $('after-encoding').value };
  const activeKeys = selectedKeys();
  if (activeKeys.length) draftMapping = { keys: activeKeys, value: $('value-select').value };
  const previousKeys = [...draftMapping.keys], previousValue = draftMapping.value;
  parsed.before = null; parsed.after = null;
  clearMapping();
  setError();
  updateFileLabels();
  setBusy(true);
  for (const side of sides) if (snapshot[side]) $(side + '-file-meta').textContent = 'Reading locally…';
  $('file-status').textContent = draftHint('Reading selected files locally.');
  const results = await Promise.allSettled(sides.map(async side => {
    if (!snapshot[side]) return null;
    const text = await readDataset(snapshot[side], encodings[side]);
    const delimiter = choice === 'auto' ? detectDelimiter(text) : choice === 'tab' ? '\t' : choice;
    return { dataset: parseCSV(text, { delimiter }), delimiter, detected: choice === 'auto' ? delimiter : detectDelimiter(text) };
  }));
  if (revision !== loadRevision) return;
  const errors = [], failed = { utf8: [], eucKr: [], fields: false };
  results.forEach((result, index) => {
    const side = sides[index];
    if (result.status === 'fulfilled') {
      parsed[side] = result.value?.dataset ?? null;
      $(side + '-drop').classList.remove('has-error');
      $(side + '-file').removeAttribute('aria-invalid');
      $(side + '-file-meta').textContent = result.value
        ? `${countLabel(parsed[side].rows.length)}, ${countLabel(parsed[side].headers.length, 'column')} · ${delimiterNames[result.value.delimiter]}${encodings[side] === 'euc-kr' ? ' · EUC-KR' : ''}`
        : 'or drop a file here';
    } else {
      $(side + '-drop').classList.add('has-error');
      $(side + '-file').setAttribute('aria-invalid', 'true');
      $(side + '-file-meta').textContent = 'Could not read this file';
      const shape = errorShape(result.reason instanceof Error ? result.reason.message : result.reason);
      if (/not valid UTF-8/.test(shape)) failed.utf8.push(side);
      else if (/not valid EUC-KR|byte order mark/.test(shape)) failed.eucKr.push(side);
      else if (/fields; expected/.test(shape)) failed.fields = true;
      errors.push(`${side === 'before' ? 'Before' : 'After'}: ${readError(result.reason)}`);
    }
  });
  const which = list => list.length === 2 ? 'both files' : `the ${list[0]} file`;
  if (errors.length) {
    const actions = [];
    if (failed.utf8.length) actions.push({ label: `Read ${which(failed.utf8)} as Korean (EUC-KR)`, run: () => setEncodings(failed.utf8, 'euc-kr') });
    if (failed.eucKr.length) actions.push({ label: `Read ${which(failed.eucKr)} as UTF-8`, run: () => setEncodings(failed.eucKr, 'utf-8') });
    if (failed.fields) actions.push(choice === 'auto' ? chooseSeparatorAction : detectSeparatorAction);
    setError(errors.join('\n'), actions, 'scroll');
    $('file-status').textContent = draftHint('Resolve the file error to continue.');
  } else if (parsed.before && parsed.after) {
    try {
      setMapping(previousKeys, previousValue);
      const problem = $('mapping-check').querySelector('.check-line.warn');
      $('file-status').textContent = draftHint(`${note}${problem
        ? 'Files read. Resolve the problems in the column check before comparing.'
        : 'Files ready. Confirm the key and metric, then select “Compare files”.'}`);
      // The check sits below the column choices, so bring a problem into view without moving focus.
      if (problem) requestAnimationFrame(() => $('mapping-check').scrollIntoView({ behavior: motion(), block: 'nearest' }));
    } catch (error) {
      clearMapping();
      // A single column usually means the file uses a different separator.
      const single = sides.filter((side, index) => results[index].value?.dataset.headers.length === 1);
      if (single.length && choice !== 'auto') {
        const suggested = [...new Set(single.map(side => results[sides.indexOf(side)].value.detected))];
        const advice = suggested.length === 1 && suggested[0] !== (choice === 'tab' ? '\t' : choice)
          ? ` ${single.length === 2 ? 'Their headers look' : 'Its header looks'} ${delimiterNames[suggested[0]]}-separated.` : '';
        setError(`${error.message} With the ${delimiterNames[choice === 'tab' ? '\t' : choice]} separator, ${which(single)} ${single.length === 2 ? 'have' : 'has'} only one column.${advice} Detect the separator, or choose it under File format and limits. The current report is unchanged.`, [detectSeparatorAction], 'scroll');
      } else if (single.length) {
        const subject = which(single);
        setError(`${error.message} ${subject[0].toUpperCase()}${subject.slice(1)} ${single.length === 2 ? 'have' : 'has'} only one column, and no comma, tab, or semicolon separator was found. Export ${single.length === 2 ? 'them' : 'it'} with one of these separators. The current report is unchanged.`, [], 'scroll');
      } else {
        setError(readError(error), [], 'scroll');
      }
      $('file-status').textContent = draftHint('Check that both files have matching column names.');
    }
  } else {
    const missing = snapshot.before ? 'after' : snapshot.after ? 'before' : 'before and after';
    $('file-status').textContent = draftHint(`${note}Choose the ${missing} ${snapshot.before || snapshot.after ? 'file' : 'files'} to continue.`);
  }
  setBusy(false);
}
function resetDraft() {
  ++loadRevision;
  clearDetails(true);
  for (const side of sides) {
    files[side] = null; parsed[side] = null;
    $(side + '-file').value = '';
    $(side + '-file').removeAttribute('aria-invalid');
    $(side + '-drop').classList.remove('has-error');
  }
  $('delimiter').value = 'auto';
  for (const side of sides) $(side + '-encoding').value = 'utf-8';
  setPairNote();
  draftMapping = { keys: isSample ? [] : [...report.keys], value: isSample ? '' : report.value };
  $('comparison-mode').value = !isSample && report.aggregation === 'sum' ? 'groups' : 'rows';
  updateMode();
  clearMapping();
  updateFileLabels();
  setError();
  setBusy(false);
  setDirty(false);
  $('file-status').textContent = 'Choose two files to start. The current report is unchanged.';
}
function openComparison() {
  clearDetails(true); // Never stack the comparison dialog on top of row details.
  if (!$('comparison-dialog').open) $('comparison-dialog').showModal();
}
function setPairNote(text = '') {
  $('pair-note').textContent = text;
  $('pair-note').hidden = !text;
}
function acceptFile(side, file) {
  if (!file) return; // Canceling the picker preserves the existing selection.
  files[side] = file;
  setPairNote();
  setDirty(true);
  loadFiles();
}
// Order two dropped files. Only the part where the names differ counts: before/after,
// old/new, 전/후 and similar words decide; otherwise names sort with numbers in order.
const beforeWords = /^(before|old|prev|previous|baseline|last|전)$/i;
const afterWords = /^(after|new|current|curr|latest|this|후)$/i;
function orderDroppedPair(a, b) {
  const stem = file => file.name.replace(/\.[^.]+$/, '').normalize('NFC').toLowerCase();
  const [x, y] = [stem(a), stem(b)];
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start += 1;
  let end = 0;
  while (end < x.length - start && end < y.length - start && x[x.length - 1 - end] === y[y.length - 1 - end]) end += 1;
  const parts = [x.slice(start, x.length - end), y.slice(start, y.length - end)].map(part => part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
  if (beforeWords.test(parts[0]) && afterWords.test(parts[1])) return { files: [a, b], rule: 'words' };
  if (afterWords.test(parts[0]) && beforeWords.test(parts[1])) return { files: [b, a], rule: 'words' };
  // A repeated browser download such as "export (1).csv" is newer than "export.csv".
  if (!parts[0] && /^\d+$/.test(parts[1])) return { files: [a, b], rule: 'copy' };
  if (!parts[1] && /^\d+$/.test(parts[0])) return { files: [b, a], rule: 'copy' };
  return { files: [a, b].sort((p, q) => p.name.localeCompare(q.name, undefined, { numeric: true, sensitivity: 'base' })), rule: 'name' };
}
// Files dropped anywhere: two files are ordered as above, one fills the first empty side.
function acceptDroppedFiles(list, side = null) {
  const dropped = Array.from(list || []);
  if (!dropped.length) return;
  openComparison();
  if (dropped.length > 2) {
    setError('Drop at most two files: one before file and one after file.', [], 'scroll');
    return;
  }
  if (dropped.length === 2) {
    const { files: [first, second], rule } = orderDroppedPair(dropped[0], dropped[1]);
    files.before = first; files.after = second;
    for (const name of sides) $(name + '-file').value = '';
    const reason = rule === 'words' ? 'from the words in their names' : rule === 'copy' ? 'treating the numbered copy as newer' : 'by file name';
    setPairNote(`Check the order: ${first.name} is Before and ${second.name} is After, ${reason}. Use the swap button between the files if that is reversed.`);
  } else {
    const target = side || (!files.before ? 'before' : !files.after ? 'after' : null);
    if (!target) {
      setError();
      $('file-status').textContent = draftHint('Both files are already chosen. Drop the new file on Before or After to replace one.');
      return;
    }
    files[target] = dropped[0];
    $(target + '-file').value = '';
    setPairNote();
  }
  setDirty(true);
  loadFiles();
}
for (const side of sides) {
  $(side + '-file').addEventListener('change', event => acceptFile(side, event.target.files[0]));
  const drop = $(side + '-drop');
  let dragDepth = 0;
  drop.addEventListener('dragenter', event => {
    event.preventDefault();
    dragDepth += 1;
    drop.classList.add('is-dragging');
  });
  drop.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) drop.classList.remove('is-dragging');
  });
  drop.addEventListener('drop', event => {
    // preventDefault marks the drop as handled for the window-level listener below.
    event.preventDefault();
    dragDepth = 0;
    drop.classList.remove('is-dragging');
    // The File object is the source of truth; no browser-specific FileList mutation.
    acceptDroppedFiles(event.dataTransfer?.files, side);
  });
}
// Without these, a file dropped outside a drop zone makes the browser open it and leave the report.
let pageDragDepth = 0;
const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
function endPageDrag() { pageDragDepth = 0; $('drop-overlay').hidden = true; }
window.addEventListener('dragenter', event => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  pageDragDepth += 1;
  // A modal dialog sits above the overlay, so show it only over the report itself.
  if (!document.querySelector('dialog[open]')) $('drop-overlay').hidden = false;
});
window.addEventListener('dragover', event => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', event => {
  if (!carriesFiles(event)) return;
  pageDragDepth = Math.max(0, pageDragDepth - 1);
  if (!pageDragDepth) $('drop-overlay').hidden = true;
});
window.addEventListener('drop', event => {
  if (!carriesFiles(event)) return;
  const handled = event.defaultPrevented;
  event.preventDefault();
  endPageDrag();
  if (!handled) acceptDroppedFiles(event.dataTransfer.files);
});
for (const id of ['delimiter', 'before-encoding', 'after-encoding']) $(id).addEventListener('change', () => { setDirty(true); loadFiles(); });
for (const id of ['key-select', 'value-select']) $(id).addEventListener('change', () => {
  updateExtraKeys(selectedKeys());
  mappingChanged();
});
$('comparison-mode').addEventListener('change', () => { updateMode(); mappingChanged(); });
$('swap-files').addEventListener('click', () => {
  [files.before, files.after] = [files.after, files.before];
  // The encoding belongs to the file, so it moves with it.
  [$('before-encoding').value, $('after-encoding').value] = [$('after-encoding').value, $('before-encoding').value];
  for (const side of sides) $(side + '-file').value = '';
  setPairNote();
  setDirty(true);
  loadFiles();
});
$('comparison-form').addEventListener('submit', event => {
  event.preventDefault();
  if (loading) return;
  try {
    setError();
    if (!parsed.before || !parsed.after || $('key-select').disabled) throw new Error('Choose two valid files before comparing.');
    if (!selectedKeys().length || !$('value-select').value) throw new Error('Choose the keys and numeric metric.');
    if (selectedKeys().includes($('value-select').value)) throw new Error('Choose different columns for keys and the numeric metric.');
    const nextReport = reconcile(parsed.before, parsed.after, {
      keys: selectedKeys(), value: $('value-select').value, aggregate: $('comparison-mode').value === 'groups',
      beforeName: files.before.name, afterName: files.after.name,
    });
    report = nextReport;
    generatedAt = new Date().toISOString();
    draftMapping = { keys: [...report.keys], value: report.value };
    isSample = false;
    setDirty(false);
    resetView();
    renderReport();
    $('file-status').textContent = 'These files and columns match the current report.';
    $('comparison-dialog').close();
    focusReport();
    showToast('Comparison ready. You can save the complete report.');
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const actions = /duplicate key/.test(errorShape(raw)) && $('comparison-mode').value === 'rows'
      ? [{ label: 'Use Group & sum', run: useGroupMode }, ...(!$('extra-keys-details').hidden ? [{ label: 'Add key columns', run: showExtraKeys }] : [])]
      : [];
    setError(readError(error), actions, 'focus');
    $('file-status').textContent = draftHint('Comparison could not be completed.');
  }
});
for (const id of ['new-comparison', 'open-comparison-inline', 'resume-comparison']) $(id).addEventListener('click', openComparison);
$('close-comparison').addEventListener('click', () => $('comparison-dialog').close());
$('comparison-dialog').addEventListener('close', () => {
  for (const side of sides) $(side + '-drop').classList.remove('is-dragging');
  setDirty(draftDirty);
});
$('reset-comparison').addEventListener('click', resetDraft);
$('discard-draft').addEventListener('click', () => {
  resetDraft();
  showToast('Draft discarded. The current report is unchanged.');
});
function loadExample(example) {
  report = example;
  isSample = true;
  generatedAt = null;
  resetDraft();
  resetView();
  renderReport();
  if ($('comparison-dialog').open) $('comparison-dialog').close();
  focusReport();
  showToast('Example report loaded.');
}
$('sample-button').addEventListener('click', () => loadExample(initial.example));
$('group-example-button').addEventListener('click', () => loadExample(report.aggregation === 'sum' ? initial.example : initial.groupExample));
for (const status of ['added', 'removed', 'changed']) $('contrib-' + status).addEventListener('click', () => selectFilter(status, true));
$('search').addEventListener('input', () => { page = 0; renderRows(); });
$('clear-search').addEventListener('click', () => { $('search').value = ''; page = 0; renderRows(); $('search').focus(); });
$('row-sort').addEventListener('change', () => { sort = $('row-sort').value; page = 0; renderRows(); });
$('reset-filters').addEventListener('click', () => {
  resetView(); filter = 'all'; renderRows(); filterButtons.get('all').button.focus();
});
$('prev-page').addEventListener('click', () => { page -= 1; renderRows(); });
$('next-page').addEventListener('click', () => { page += 1; renderRows(); });
$('close-dialog').addEventListener('click', () => $('row-dialog').close());
$('row-dialog').addEventListener('close', () => clearDetails());

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = element('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// Name downloads after the compared files so several reports can sit side by side.
function exportName(kind, extension) {
  if (isSample) return `rowglass-${kind}.${extension}`;
  // Keep letters with their combining marks, cut by code point, then trim separators.
  const stem = name => Array.from(name.replace(/\.[^.]+$/, '').normalize('NFC').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-'))
    .slice(0, 40).join('').replace(/^[\p{M}.-]+|[.-]+$/gu, '') || 'file';
  return `rowglass-${stem(report.beforeName)}-vs-${stem(report.afterName)}-${kind}.${extension}`;
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const previous = document.activeElement;
    const area = element('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    area.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    return copied;
  }
}
function encodeState(value) { return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function cleanExport() {
  const copy = document.documentElement.cloneNode(true);
  const get = id => copy.querySelector('#' + id);
  get('rowglass-data').textContent = encodeState({ report, sample: isSample, example: initial.example, groupExample: initial.groupExample, generatedAt: isSample ? null : generatedAt });
  for (const dialog of copy.querySelectorAll('dialog')) dialog.removeAttribute('open');
  for (const side of sides) {
    get(side + '-file').value = '';
    get(side + '-file').removeAttribute('value');
    get(side + '-file').removeAttribute('aria-invalid');
    get(side + '-file-label').textContent = 'Choose a CSV file';
    get(side + '-file-meta').textContent = 'or drop a file here';
    get(side + '-drop').classList.remove('is-loaded', 'is-dragging', 'has-error');
    get(side + '-drop').setAttribute('aria-busy', 'false');
  }
  for (const id of ['key-select', 'value-select']) {
    const option = element('option', 'Choose files first'); option.value = '';
    get(id).replaceChildren(option); get(id).disabled = true;
  }
  for (const [id, value] of [['delimiter', 'auto'], ['before-encoding', 'utf-8'], ['after-encoding', 'utf-8'], ['row-sort', 'impact'], ['comparison-mode', 'rows']]) {
    for (const option of get(id).options) {
      option.selected = option.value === value;
      if (option.selected) option.setAttribute('selected', ''); else option.removeAttribute('selected');
    }
  }
  get('mapping-fields').hidden = true;
  get('extra-keys').replaceChildren();
  get('extra-keys-details').removeAttribute('open');
  get('extra-key-summary').textContent = 'Add key columns';
  get('export-options').removeAttribute('open');
  for (const id of ['key-preview', 'value-preview']) get(id).removeAttribute('title');
  get('comparison-form').setAttribute('aria-busy', 'false');
  get('compare').disabled = true;
  get('swap-files').disabled = true;
  get('draft-notice').hidden = true;
  for (const id of exportIds) get(id).disabled = false;
  get('export-scope').textContent = `Includes all ${reportCount(report.rows.length)}, even when filtered.`;
  get('search').value = '';
  get('search').removeAttribute('value');
  get('clear-search').hidden = true;
  get('error').hidden = true;
  get('error-actions').hidden = true;
  get('drop-overlay').hidden = true;
  get('pair-note').hidden = true;
  get('mapping-check').classList.remove('has-error-actions');
  get('toast').hidden = true;
  get('toast').classList.remove('is-visible');
  get('calculation-details').removeAttribute('open');
  // Remove every dynamic editor/detail value, including unselected source cells.
  // Clear rendered report blocks too; the saved state reconstructs them on open.
  for (const id of [
    'key-preview', 'value-preview', 'error-text', 'error-actions', 'mapping-check', 'pair-note', 'file-status', 'detail-key', 'detail-status', 'detail-values', 'detail-note', 'toast',
    'report-kind', 'report-title', 'summary-description', 'before-name', 'after-name', 'report-source',
    'total-before', 'total-after', 'total-delta', 'count-before', 'count-after', 'percent-change', 'metric-label', 'key-summary', 'row-change-count',
    'added-total', 'added-count', 'removed-total', 'removed-count', 'changed-total', 'changed-count',
    'waterfall', 'equation', 'drivers', 'schema-note', 'filters', 'rows', 'key-heading', 'row-total', 'scope-note', 'page-note',
    'aggregation-note', 'rows-title', 'data-export-scope',
    'report-notices', 'drivers-summary', 'generated-at', 'chart-axis-note', 'changed-split',
  ]) get(id).replaceChildren();
  get('detail-status').classList.remove('added', 'removed', 'changed', 'unchanged');
  get('detail-status').classList.add('status-pill');
  return '<!doctype html>\n' + copy.outerHTML;
}
function closeExports(restoreFocus = false) {
  $('export-options').open = false;
  if (restoreFocus) $('export-options').querySelector('summary').focus();
}
$('export-options').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeExports(true); }
});
document.addEventListener('click', event => {
  if (!$('export-options').contains(event.target)) closeExports();
});
function canExport() {
  if (!draftDirty) return true;
  showToast('Apply or discard the draft before saving this report.');
  return false;
}
$('export-json').addEventListener('click', () => {
  if (!canExport()) return;
  closeExports(true);
  download(JSON.stringify(report, null, 2), exportName('report', 'json'), 'application/json');
  showToast(`JSON download started. Includes all ${reportCount(report.rows.length)}.`);
});
$('export-html').addEventListener('click', () => {
  if (!canExport()) return;
  download(cleanExport(), exportName('report', 'html'), 'text/html');
  showToast(`HTML download started. Includes all ${reportCount(report.rows.length)}.`);
});
$('export-csv').addEventListener('click', () => {
  if (!canExport()) return;
  closeExports(true);
  download(renderChangesCSV(report), exportName('changes', 'csv'), 'text/csv;charset=utf-8');
  showToast(`CSV download started. All ${reportCount(report.counts.added + report.counts.removed + report.counts.changed)} with changes are included.`);
});
$('export-markdown').addEventListener('click', () => {
  if (!canExport()) return;
  closeExports(true);
  download(renderMarkdown(report), exportName('summary', 'md'), 'text/markdown;charset=utf-8');
  showToast('Markdown downloaded. Includes totals and the 10 largest changes.');
});
$('copy-markdown').addEventListener('click', async () => {
  if (!canExport()) return;
  closeExports(true);
  const copied = await copyText(renderMarkdown(report));
  showToast(copied ? 'Markdown summary copied. Paste it into an issue, chat, or document.' : 'Copy was blocked by the browser. Use “Markdown summary” to download it instead.');
});
initializeFilters();
resetDraft();
resetView();
renderReport();
