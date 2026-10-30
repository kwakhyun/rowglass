/**
 * Portable text exports for reports returned by Rowglass's reconciliation engine.
 * No dependencies, imports, browser APIs, or mutations of the supplied report.
 *
 * CSV policy: untrusted text that starts with =, +, -, or @ after whitespace,
 * control characters, or invisible formatting characters gets an initial
 * apostrophe. This intentionally changes dangerous key text in the CSV so a
 * spreadsheet can treat it as text. Headers have fixed nonformula prefixes and
 * pass through the same protection. CSV quoting alone is not formula protection.
 * Validated decimal fields bypass that text policy, preserving negative amounts
 * and every decimal digit. Spreadsheet imports can still infer/round numbers;
 * the CSV bytes and JSON report retain the exact strings.
 *
 * Markdown policy: untrusted strings are JSON-escaped inside inline code spans
 * whose backtick delimiter is longer than any run in the string. Pipes and
 * invisible formatting characters use visible Unicode escapes. No source text
 * can create raw HTML, a Markdown link, a new table row, or an active code fence.
 * Only selected identity values and the numeric metric are included.
 */

function rowglassExportDecimal(value, nullable = false) {
  if (nullable && value === null) return '';
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError('Exports require exact decimal strings from a reconciliation report.');
  }
  return value;
}

function rowglassExportCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Exports require nonnegative integer row counts.');
  }
  return String(value);
}

function rowglassExportStatus(value) {
  if (!['added', 'removed', 'changed', 'unchanged'].includes(value)) {
    throw new TypeError('Exports require a known reconciliation status.');
  }
  return value;
}

function rowglassExportCSVCell(value, untrusted = false) {
  let text = String(value);
  if (untrusted && /^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@]/u.test(text)) {
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function rowglassExportMarkdownCell(value) {
  const escaped = JSON.stringify(String(value))
    .replace(/\|/g, '\\u007c')
    .replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  let run = 0, longest = 0;
  for (const char of escaped) {
    run = char === '\u0060' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const ticks = '\u0060'.repeat(longest + 1);
  return ticks + ' ' + escaped + ' ' + ticks;
}

function rowglassExportMagnitude(decimal) {
  const value = rowglassExportDecimal(decimal).replace(/^-/, '');
  const [integer, fraction = ''] = value.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

function rowglassExportLargestChanges(rows) {
  return rows.map((row, index) => ({
    row, index, magnitude: rowglassExportMagnitude(row.delta),
  })).sort((a, b) => {
    const left = a.magnitude.coefficient * 10n ** BigInt(b.magnitude.scale);
    const right = b.magnitude.coefficient * 10n ** BigInt(a.magnitude.scale);
    return left === right ? a.index - b.index : left > right ? -1 : 1;
  }).slice(0, 10).map(entry => entry.row);
}

/** Export every added, removed, or numerically changed row, independent of UI filters. */
export function renderChangesCSV(report) {
  const grouped = report.aggregation === 'sum';
  const headers = [
    ...report.keys.map(key => 'key:' + key),
    'before:' + report.value, 'after:' + report.value, 'delta:' + report.value,
    'status', ...(grouped ? ['beforeCount', 'afterCount'] : []),
  ];
  const lines = [headers.map(header => rowglassExportCSVCell(header, true)).join(',')];
  for (const row of report.rows) {
    const status = rowglassExportStatus(row.status);
    if (status === 'unchanged') continue;
    const fields = [
      ...row.key.map(key => rowglassExportCSVCell(key, true)),
      rowglassExportCSVCell(rowglassExportDecimal(row.before, true)),
      rowglassExportCSVCell(rowglassExportDecimal(row.after, true)),
      rowglassExportCSVCell(rowglassExportDecimal(row.delta)),
      status,
      ...(grouped ? [rowglassExportCount(row.beforeCount), rowglassExportCount(row.afterCount)] : []),
    ];
    lines.push(fields.join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Render a concise Markdown summary with the ten largest exact absolute contributions. */
export function renderMarkdown(report) {
  const grouped = report.aggregation === 'sum';
  const unit = grouped ? 'groups' : 'rows';
  const changes = report.rows.filter(row => rowglassExportStatus(row.status) !== 'unchanged');
  const top = rowglassExportLargestChanges(changes);
  const lines = [
    '# Rowglass comparison',
    '',
    'Exact arithmetic contributors to one changed total; not business causes.',
    '',
    grouped
      ? 'Granularity: groups. Each selected key combination is summed before comparison. Statuses describe group sums, not individual source-row changes.'
      : 'Granularity: unique rows matched by the selected key columns. Other cell values are not compared.',
    '',
    '| Selected input | Value |',
    '| --- | --- |',
    '| Before file | ' + rowglassExportMarkdownCell(report.beforeName) + ' |',
    '| After file | ' + rowglassExportMarkdownCell(report.afterName) + ' |',
    '| Key columns | ' + report.keys.map(rowglassExportMarkdownCell).join(', ') + ' |',
    '| Numeric column | ' + rowglassExportMarkdownCell(report.value) + ' |',
    '| Aggregation | ' + (grouped ? 'sum' : 'none') + ' |',
    '',
    '| Total | Exact value |',
    '| --- | ---: |',
    '| Before | ' + rowglassExportDecimal(report.totals.before) + ' |',
    '| After | ' + rowglassExportDecimal(report.totals.after) + ' |',
    '| Difference | ' + rowglassExportDecimal(report.totals.delta) + ' |',
    '',
    '| Change type | ' + (grouped ? 'Groups' : 'Rows') + ' | Contribution to difference |',
    '| --- | ---: | ---: |',
    ...['added', 'removed', 'changed'].map(status =>
      '| ' + status + ' | ' + rowglassExportCount(report.counts[status]) + ' | ' + rowglassExportDecimal(report.totals[status]) + ' |'),
    '| unchanged | ' + rowglassExportCount(report.counts.unchanged) + ' | 0 |',
    '',
    '| Population | Before | After |',
    '| --- | ---: | ---: |',
    '| ' + (grouped ? 'Groups' : 'Rows') + ' | ' + rowglassExportCount(report.counts.before) + ' | ' + rowglassExportCount(report.counts.after) + ' |',
    ...(grouped ? ['| Source rows | ' + rowglassExportCount(report.sourceCounts.before) + ' | ' + rowglassExportCount(report.sourceCounts.after) + ' |'] : []),
    '',
    '## Largest changes',
    '',
    'All ' + changes.length + ' changed ' + unit + ' considered, independent of table filters. Showing ' + top.length + '. Omitted: ' + (changes.length - top.length) + ' changed ' + unit + '.',
    '',
  ];
  if (top.length) {
    const headers = [
      ...report.keys.map(key => rowglassExportMarkdownCell('key:' + key)),
      'Before', 'After', 'Difference', 'Status',
      ...(grouped ? ['Source rows before', 'Source rows after'] : []),
    ];
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    for (const row of top) {
      const fields = [
        ...row.key.map(rowglassExportMarkdownCell),
        rowglassExportDecimal(row.before, true) || '—',
        rowglassExportDecimal(row.after, true) || '—',
        rowglassExportDecimal(row.delta), rowglassExportStatus(row.status),
        ...(grouped ? [rowglassExportCount(row.beforeCount), rowglassExportCount(row.afterCount)] : []),
      ];
      lines.push('| ' + fields.join(' | ') + ' |');
    }
  } else {
    lines.push('No changed ' + unit + '.');
  }
  lines.push('', 'Text is shown as escaped strings. Missing before/after values are marked —. No raw source files or unselected cell values are included.', '');
  return lines.join('\n');
}

