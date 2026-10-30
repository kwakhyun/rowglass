// Embedded after engine.mjs in a single browser module; no external requests.
const $ = id => document.getElementById(id);
const initial = JSON.parse($('rowglass-data').textContent);
let report = initial.report;
let isSample = initial.sample;
let filter = 'changes';
let sort = 'impact';
let page = 0;
let loadRevision = 0;
let loading = false;
let draftDirty = false;
let draftMapping = { keys: [], value: '' };
const exportIds = ['export-html', 'export-json', 'export-csv', 'export-markdown'];
let toastTimer;
const pageSize = 40;
const sides = ['before', 'after'];
const files = { before: null, after: null };
const parsed = { before: null, after: null };
const labels = { added: 'Added', removed: 'Removed', changed: 'Value changed', unchanged: 'Same value' };
const filterNames = { changes: 'Changes', added: 'Added', removed: 'Removed', changed: 'Value changed', all: 'All rows' };
const sortNames = { impact: 'largest impact first', key: 'key order', increase: 'largest increase first', decrease: 'largest decrease first' };
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
function scrollToRows() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('rows-label').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}
function focusReport() {
  requestAnimationFrame(() => {
    $('report-title').focus({ preventScroll: true });
    $('report-title').scrollIntoView({ behavior: 'auto', block: 'start' });
  });
}
function setError(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
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
function setDirty(value) {
  draftDirty = value;
  $('draft-notice').hidden = !value;
  for (const id of exportIds) $(id).disabled = value;
  $('export-scope').textContent = `Includes all ${reportCount(report.rows.length)}, even when filtered.`;
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
  $('data-export-scope').textContent = `CSV: all ${reportCount(changedCount)} with changes. Markdown: top 10 changes. JSON: all ${reportCount(report.rows.length)}. Table filters do not affect exports.`;
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
  const term = value => units(value) === 0n ? `+${display(value)}` : display(value, true);
  $('equation').textContent = `${display(report.totals.before)} ${term(report.totals.added)} ${term(report.totals.removed)} ${term(report.totals.changed)} = ${display(report.totals.after)}`;
  drawWaterfall();
  renderDrivers();
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
  const bars = [
    { label: 'Before', from: 0n, to: before, exact: totals.before },
    { label: 'Added', from: before, to: addedEnd, exact: totals.added, filter: 'added' },
    { label: 'Removed', from: addedEnd, to: removedEnd, exact: totals.removed, filter: 'removed' },
    { label: 'Value changed', from: removedEnd, to: after, exact: totals.changed, filter: 'changed' },
    { label: 'After', from: 0n, to: after, exact: totals.after },
  ];
  const ends = [0n, ...bars.flatMap(bar => [bar.from, bar.to])];
  const min = ends.reduce((a, b) => a < b ? a : b), max = ends.reduce((a, b) => a > b ? a : b);
  const range = max - min || 1n;
  // Only the chart geometry is approximate; arithmetic and labels stay exact.
  const y = value => 200 - Number((value - min) * 154000n / range) / 1000;
  const svg = svgNode('svg', { viewBox: '0 0 660 254', role: 'group', 'aria-label': `Total changed from ${totals.before} to ${totals.after}. Added ${totals.added}, removed contribution ${totals.removed}, matched value changes ${totals.changed}.` });
  svg.append(svgNode('line', { x1: 22, x2: 640, y1: y(0n), y2: y(0n), stroke: '#d9dfe7', 'stroke-width': 1 }));
  bars.forEach((bar, index) => {
    const x = 37 + index * 127, width = 80;
    const top = Math.min(y(bar.from), y(bar.to));
    const height = Math.max(2, Math.abs(y(bar.from) - y(bar.to)));
    const color = bar.filter ? units(bar.exact) < 0n ? '#b45323' : '#2563eb' : '#4e5968';
    const group = svgNode('g', bar.filter ? { class: 'chart-bar', role: 'button', tabindex: 0, 'aria-label': `${bar.label}: ${display(bar.exact, true)}. Show rows.` } : {});
    group.append(svgNode('rect', { x, y: top, width, height, fill: color, rx: 3 }));
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
    $(side + '-file-meta').textContent = files[side] ? 'Ready to read' : 'CSV or TSV, up to 20 MiB';
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
function updateExtraKeys(wanted = selectedKeys()) {
  const primary = $('key-select').value, metric = $('value-select').value;
  const common = parsed.before?.headers.filter(header => parsed.after?.headers.includes(header)) || [];
  $('extra-keys').replaceChildren();
  for (const name of common.filter(name => name !== primary && name !== metric)) {
    const label = element('label', undefined, 'key-choice');
    const input = element('input'); input.type = 'checkbox'; input.value = name;
    input.checked = wanted.includes(name);
    input.addEventListener('change', () => {
      draftMapping = { keys: selectedKeys(), value: $('value-select').value };
      setDirty(true); setError(); updateKeySummary(); updatePreviews();
    });
    label.append(input, element('span', name)); $('extra-keys').append(label);
  }
  $('extra-keys-details').hidden = !common.some(name => name !== primary && name !== metric);
  updateKeySummary();
}
function updateKeySummary() {
  const count = selectedKeys().length;
  $('extra-key-summary').textContent = count > 1 ? `${count} key columns selected` : 'Add key columns';
}
function setMapping(previousKeys, previousValue) {
  const common = parsed.before.headers.filter(header => parsed.after.headers.includes(header));
  if (common.length < 2) throw new Error('The files need at least two shared columns: keys and a numeric metric.');
  for (const id of ['key-select', 'value-select']) {
    const select = $(id); select.replaceChildren();
    const placeholder = element('option', 'Choose a column'); placeholder.value = ''; select.append(placeholder);
    for (const header of common) {
      const option = element('option', header); option.value = header; select.append(option);
    }
    select.disabled = false;
  }
  const missingKeys = previousKeys.some(key => !common.includes(key));
  $('key-select').value = missingKeys ? '' : previousKeys[0] || common.find(header => /^(id|account|name|key)$/i.test(header)) || common[0];
  $('value-select').value = previousValue ? (common.includes(previousValue) ? previousValue : '')
    : common.find(header => /^(amount|revenue|cost|total|value|usage)$/i.test(header) && header !== $('key-select').value) || common.find(header => header !== $('key-select').value);
  updateExtraKeys(missingKeys ? [] : previousKeys);
  $('mapping-fields').hidden = false;
  updateMode(); updatePreviews();
  if (missingKeys || (previousValue && !common.includes(previousValue))) {
    setError('Previously selected columns are missing. Choose the keys and numeric column again; no replacement has been assumed.');
  }
}
function readError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const hint = /UTF-8|encoded data/i.test(raw)
    ? 'Re-export the file as UTF-8 CSV or TSV, then choose it again.'
    : /20 MiB|100,000 row/.test(raw)
      ? 'Use a smaller export within the file and row limits.'
      : /decimal|integer digit|decimal place/.test(raw)
        ? 'Choose a numeric column without blanks, currency symbols, separators, or surrounding spaces.'
        : /duplicate key|blank key/.test(raw)
          ? 'Add key columns to identify rows uniquely, or explicitly choose Group & sum to compare totals. Blank keys must be fixed in the source.'
          : 'Check the selected columns, file contents, and delimiter, then try again.';
  return `${raw} ${hint} The current report is unchanged.`;
}
async function readDataset(file) {
  if (file.size > MAX_TEXT_BYTES) throw new Error('File exceeds the 20 MiB limit.');
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_TEXT_BYTES) throw new Error('File exceeds the 20 MiB limit.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch (error) { throw new Error(`File must be valid UTF-8. ${error.message}`); }
  return text;
}
async function loadFiles() {
  const revision = ++loadRevision;
  const snapshot = { ...files };
  const delimiter = $('delimiter').value === 'tab' ? '\t' : ',';
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
  const results = await Promise.allSettled(sides.map(async side => snapshot[side] ? parseCSV(await readDataset(snapshot[side]), { delimiter }) : null));
  if (revision !== loadRevision) return;
  const errors = [];
  results.forEach((result, index) => {
    const side = sides[index];
    if (result.status === 'fulfilled') {
      parsed[side] = result.value;
      $(side + '-drop').classList.remove('has-error');
      $(side + '-file').removeAttribute('aria-invalid');
      $(side + '-file-meta').textContent = result.value
        ? `${countLabel(result.value.rows.length)}, ${countLabel(result.value.headers.length, 'column')}`
        : 'CSV or TSV, up to 20 MiB';
    } else {
      $(side + '-drop').classList.add('has-error');
      $(side + '-file').setAttribute('aria-invalid', 'true');
      $(side + '-file-meta').textContent = 'Could not read this file';
      errors.push(`${side === 'before' ? 'Before' : 'After'}: ${readError(result.reason)}`);
    }
  });
  if (errors.length) {
    setError(errors.join('\n'));
    $('file-status').textContent = draftHint('Resolve the file error to continue.');
  } else if (parsed.before && parsed.after) {
    try {
      setMapping(previousKeys, previousValue);
      $('file-status').textContent = draftHint('Files ready. Confirm the key and metric, then select “Compare files”.');
    } catch (error) {
      clearMapping();
      setError(readError(error));
      $('file-status').textContent = draftHint('Check that both files have matching column names.');
    }
  } else {
    const missing = snapshot.before ? 'after' : snapshot.after ? 'before' : 'before and after';
    $('file-status').textContent = draftHint(`Choose the ${missing} ${snapshot.before || snapshot.after ? 'file' : 'files'} to continue.`);
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
  $('delimiter').value = ',';
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
  if (!$('comparison-dialog').open) $('comparison-dialog').showModal();
}
function acceptFile(side, file) {
  if (!file) return; // Canceling the picker preserves the existing selection.
  files[side] = file;
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
    event.preventDefault(); event.stopPropagation();
    dragDepth = 0;
    drop.classList.remove('is-dragging');
    const dropped = event.dataTransfer?.files;
    if (!dropped?.length) return;
    if (dropped.length !== 1) { setError('Choose one file for each side. Drop the before and after files into their separate areas.'); return; }
    // The File object is the source of truth; no browser-specific FileList mutation.
    $(side + '-file').value = '';
    acceptFile(side, dropped[0]);
  });
}
$('delimiter').addEventListener('change', () => { setDirty(true); loadFiles(); });
for (const id of ['key-select', 'value-select']) $(id).addEventListener('change', () => {
  const wanted = selectedKeys();
  updateExtraKeys(wanted);
  draftMapping = { keys: selectedKeys(), value: $('value-select').value };
  setDirty(true); setError(); updatePreviews(); setBusy(false);
  $('file-status').textContent = draftHint('Mapping updated. Select “Compare files” to apply it.');
});
$('comparison-mode').addEventListener('change', () => { setDirty(true); setError(); updateMode(); });
$('swap-files').addEventListener('click', () => {
  [files.before, files.after] = [files.after, files.before];
  for (const side of sides) $(side + '-file').value = '';
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
    setError(readError(error));
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
function encodeState(value) { return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function cleanExport() {
  const copy = document.documentElement.cloneNode(true);
  const get = id => copy.querySelector('#' + id);
  get('rowglass-data').textContent = encodeState({ report, sample: isSample, example: initial.example, groupExample: initial.groupExample });
  for (const dialog of copy.querySelectorAll('dialog')) dialog.removeAttribute('open');
  for (const side of sides) {
    get(side + '-file').value = '';
    get(side + '-file').removeAttribute('value');
    get(side + '-file').removeAttribute('aria-invalid');
    get(side + '-file-label').textContent = 'Choose a CSV file';
    get(side + '-file-meta').textContent = 'CSV or TSV, up to 20 MiB';
    get(side + '-drop').classList.remove('is-loaded', 'is-dragging', 'has-error');
    get(side + '-drop').setAttribute('aria-busy', 'false');
  }
  for (const id of ['key-select', 'value-select']) {
    const option = element('option', 'Choose files first'); option.value = '';
    get(id).replaceChildren(option); get(id).disabled = true;
  }
  for (const [id, value] of [['delimiter', ','], ['row-sort', 'impact'], ['comparison-mode', 'rows']]) {
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
  get('toast').hidden = true;
  get('toast').classList.remove('is-visible');
  get('calculation-details').removeAttribute('open');
  // Remove every dynamic editor/detail value, including unselected source cells.
  // Clear rendered report blocks too; the saved state reconstructs them on open.
  for (const id of [
    'key-preview', 'value-preview', 'error', 'file-status', 'detail-key', 'detail-status', 'detail-values', 'detail-note', 'toast',
    'report-kind', 'report-title', 'summary-description', 'before-name', 'after-name', 'report-source',
    'total-before', 'total-after', 'total-delta', 'count-before', 'count-after', 'percent-change', 'metric-label', 'key-summary', 'row-change-count',
    'added-total', 'added-count', 'removed-total', 'removed-count', 'changed-total', 'changed-count',
    'waterfall', 'equation', 'drivers', 'schema-note', 'filters', 'rows', 'key-heading', 'row-total', 'scope-note', 'page-note',
    'aggregation-note', 'rows-title', 'data-export-scope',
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
  download(JSON.stringify(report, null, 2), 'rowglass-report.json', 'application/json');
  showToast(`JSON download started. Includes all ${reportCount(report.rows.length)}.`);
});
$('export-html').addEventListener('click', () => {
  if (!canExport()) return;
  download(cleanExport(), 'rowglass-report.html', 'text/html');
  showToast(`HTML download started. Includes all ${reportCount(report.rows.length)}.`);
});
$('export-csv').addEventListener('click', () => {
  if (!canExport()) return;
  closeExports(true);
  download(renderChangesCSV(report), 'rowglass-changes.csv', 'text/csv;charset=utf-8');
  showToast(`CSV download started. All ${reportCount(report.counts.added + report.counts.removed + report.counts.changed)} with changes are included.`);
});
$('export-markdown').addEventListener('click', () => {
  if (!canExport()) return;
  closeExports(true);
  download(renderMarkdown(report), 'rowglass-summary.md', 'text/markdown;charset=utf-8');
  showToast('Markdown downloaded. Includes totals and the 10 largest changes.');
});
initializeFilters();
resetDraft();
resetView();
renderReport();
