import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, reconcile } from '../src/engine.mjs';
import { renderChangesCSV, renderMarkdown } from '../src/exports.mjs';

function exportReport(beforeRows, afterRows, options = {}, headers = ['account', 'amount', 'private_note']) {
  return reconcile({ headers, rows: beforeRows }, { headers, rows: afterRows }, options);
}

test('changes CSV exports every changed row with explicit columns, exact amounts and empty missing values', () => {
  const report = exportReport(
    [['A', '1.10', 'SECRET-A'], ['B', '-2.50', 'SECRET-B'], ['same', '4', 'SECRET-C']],
    [['A', '1.30', 'SECRET-D'], ['C', '-0.25', 'SECRET-E'], ['same', '4.00', 'SECRET-F']],
  );
  report.filter = 'added';
  report.query = 'C';
  const csv = renderChangesCSV(report);
  assert.deepEqual(parseCSV(csv), {
    headers: ['key:account', 'before:amount', 'after:amount', 'delta:amount', 'status'],
    rows: [
      ['A', '1.10', '1.30', '0.20', 'changed'],
      ['B', '-2.50', '', '2.50', 'removed'],
      ['C', '', '-0.25', '-0.25', 'added'],
    ],
  });
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.includes('SECRET'));
  assert.ok(!csv.includes('same'));
  assert.ok(!csv.includes("'-2.50"));
});

test('changes CSV is header-only for unchanged or empty reports and still exports zero-value additions', () => {
  const same = exportReport([['A', '1', 'old']], [['A', '1.00', 'new']]);
  assert.equal(renderChangesCSV(same), 'key:account,before:amount,after:amount,delta:amount,status\r\n');
  const empty = exportReport([], []);
  assert.equal(renderChangesCSV(empty), renderChangesCSV(same));
  const added = exportReport([], [['zero', '0.00', 'x']]);
  assert.deepEqual(parseCSV(renderChangesCSV(added)).rows, [['zero', '', '0.00', '0.00', 'added']]);
});

test('CSV preserves long decimals and fractional cents without numeric coercion', () => {
  const before = '999999999999999999999999999999.000000000001';
  const after = '999999999999999999999999999999.000000000002';
  const report = exportReport([['large', before, 'x']], [['large', after, 'y']]);
  const rows = parseCSV(renderChangesCSV(report)).rows;
  assert.equal(rows[0][1], before);
  assert.equal(rows[0][2], after);
  assert.equal(rows[0][3], '0.000000000001');
  const md = renderMarkdown(report);
  assert.ok(md.includes('| Before | ' + before + ' |'));
  assert.ok(md.includes('| Difference | 0.000000000001 |'));
});

test('CSV escapes hostile header/key quotes, delimiters and newlines without injecting records or formulas', () => {
  const keyColumn = '=KEY,"x"\r\n@other';
  const valueColumn = '\t+VALUE,"y"\n-else';
  const keys = ['=1+1', '+CMD', '-12', '@SUM(A1)', ' \t=HYPERLINK("https://example.com")', '\u0000\r\n-1+2', '\u200b@SUM(A1)', '\ufeff+CMD', 'normal,"quoted"\r\nsecond line', "'=already-text"];
  const headers = [keyColumn, valueColumn];
  const report = exportReport([], keys.map(key => [key, '-0.25']), {
    keys: [keyColumn], value: valueColumn,
  }, headers);
  const parsed = parseCSV(renderChangesCSV(report));
  assert.deepEqual(parsed.headers, [
    'key:' + keyColumn, 'before:' + valueColumn, 'after:' + valueColumn, 'delta:' + valueColumn, 'status',
  ]);
  assert.equal(parsed.rows.length, keys.length);
  assert.deepEqual(parsed.rows.map(row => row[0]), keys.map((key, index) => index < 8 ? "'" + key : key));
  assert.ok(parsed.rows.every(row => row.length === 5 && row[2] === '-0.25' && row[3] === '-0.25'));
});

test('composite identity values stay in distinct CSV columns', () => {
  const headers = ['account', 'service', 'amount'];
  const report = exportReport(
    [['a|b', 'c', '1'], ['a', 'b|c', '2']],
    [['a|b', 'c', '2'], ['a', 'b|c', '3']],
    { keys: ['account', 'service'] }, headers,
  );
  const parsed = parseCSV(renderChangesCSV(report));
  assert.deepEqual(parsed.headers, ['key:account', 'key:service', 'before:amount', 'after:amount', 'delta:amount', 'status']);
  assert.deepEqual(parsed.rows.map(row => row.slice(0, 2)), [['a|b', 'c'], ['a', 'b|c']]);
});

test('group exports distinguish group counts from source rows and omit unchanged group sums', () => {
  const report = exportReport(
    [['A', '0.10', 'x'], ['A', '0.20', 'x'], ['B', '1', 'x'], ['B', '-1', 'x'], ['same', '1', 'x'], ['same', '1', 'x']],
    [['A', '0.10', 'x'], ['A', '0.20', 'x'], ['A', '0.30', 'x'], ['N', '-2', 'x'], ['N', '-3', 'x'], ['same', '2', 'x']],
    { aggregate: true },
  );
  const parsed = parseCSV(renderChangesCSV(report));
  assert.deepEqual(parsed.headers, ['key:account', 'before:amount', 'after:amount', 'delta:amount', 'status', 'beforeCount', 'afterCount']);
  assert.deepEqual(parsed.rows, [
    ['A', '0.30', '0.60', '0.30', 'changed', '2', '3'],
    ['B', '0.00', '', '0.00', 'removed', '2', '0'],
    ['N', '', '-5.00', '-5.00', 'added', '0', '2'],
  ]);
  const md = renderMarkdown(report);
  assert.ok(md.includes('Granularity: groups.'));
  assert.ok(md.includes('Statuses describe group sums, not individual source-row changes.'));
  assert.ok(md.includes('| Aggregation | sum |'));
  assert.ok(md.includes('| Groups | 3 | 3 |'));
  assert.ok(md.includes('| Source rows | 6 | 6 |'));
  assert.ok(md.includes('| Source rows before | Source rows after |'));
  assert.ok(md.includes('All 3 changed groups considered'));
});

test('Markdown ranks exact absolute deltas above the Number precision limit and declares omissions', () => {
  const changes = [
    ['less', '9007199254740992.000000000001', 'secret'],
    ['more', '9007199254740992.000000000002', 'secret'],
    ['negative-largest', '-999999999999999999999999999999.000000000001', 'secret'],
    ...Array.from({ length: 9 }, (_, i) => ['tiny-' + (i + 1), String(i + 1), 'secret']),
  ];
  const report = exportReport([['same', '1', 'x']], [['same', '1', 'y'], ...changes]);
  const md = renderMarkdown(report);
  assert.ok(md.includes('All 12 changed rows considered, independent of table filters. Showing 10. Omitted: 2 changed rows.'));
  assert.ok(md.indexOf('"negative-largest"') < md.indexOf('"more"'));
  assert.ok(md.indexOf('"more"') < md.indexOf('"less"'));
  assert.ok(md.indexOf('"less"') < md.indexOf('"tiny-9"'));
  assert.ok(md.indexOf('"tiny-9"') < md.indexOf('"tiny-3"'));
  assert.ok(!md.includes('"tiny-1"'));
  assert.ok(!md.includes('"tiny-2"'));
  assert.ok(!md.includes('"same"'));
  assert.ok(!md.includes('secret'));
});

test('Markdown ordering supports differing decimal scales and keeps equal magnitudes stable', () => {
  const report = exportReport([], [['first', '1.2', 'x'], ['second', '-1.2', 'x'], ['larger', '1.21', 'x']]);
  report.rows[0].delta = '1.20';
  report.rows[1].delta = '-1.20000';
  const md = renderMarkdown(report);
  assert.ok(md.indexOf('"larger"') < md.indexOf('"first"'));
  assert.ok(md.indexOf('"first"') < md.indexOf('"second"'));
  assert.ok(md.includes('-1.20000'));
});

test('Markdown contains a complete useful zero-change summary without invented top rows', () => {
  const report = exportReport([['same', '1.20', 'secret']], [['same', '1.2', 'secret']]);
  const md = renderMarkdown(report);
  assert.ok(md.includes('| Before | 1.20 |'));
  assert.ok(md.includes('| After | 1.20 |'));
  assert.ok(md.includes('| Difference | 0.00 |'));
  assert.ok(md.includes('| unchanged | 1 | 0 |'));
  assert.ok(md.includes('Showing 0. Omitted: 0 changed rows.'));
  assert.ok(md.includes('No changed rows.'));
  assert.ok(!md.includes('"same"'));
  assert.ok(!md.includes('Source rows'));
});

test('Markdown safely contains HTML, links, table pipes, controls and backtick fences as literal text', () => {
  const keyColumn = 'key|[link](javascript:alert(1))\n<script>';
  const metric = 'money\r\n|x|<img src=x>';
  const key = 'a' + '\u0060'.repeat(3) + 'b|![image](https://evil.example/x)\n</script><script>alert(1)</script>\t\u202e';
  const report = exportReport([], [[key, '2']], {
    keys: [keyColumn], value: metric,
    beforeName: '<iframe src="https://evil.example">|before\n.csv',
    afterName: '[open](javascript:alert(1))\u0060after.csv',
  }, [keyColumn, metric]);
  report.rawSource = 'SHOULD-NOT-LEAK';
  report.secret = 'SHOULD-NOT-LEAK';
  report.rows[0].unselected = 'SHOULD-NOT-LEAK';
  const md = renderMarkdown(report);
  const keyLine = md.split('\n').find(line => line.includes('a' + '\u0060'.repeat(3) + 'b'));
  assert.ok(keyLine.startsWith('| ' + '\u0060'.repeat(4) + ' "'));
  assert.ok(keyLine.includes('\\u007c![image](https://evil.example/x)\\n'));
  assert.ok(keyLine.includes('\\t\\u202e" ' + '\u0060'.repeat(4) + ' |'));
  assert.equal(keyLine.split('|').length, 7, 'untrusted pipe must not create a table cell');
  assert.ok(!md.includes('\r'));
  assert.ok(!md.includes('\t'));
  assert.ok(!md.includes('\u202e'));
  assert.ok(!md.split('\n').some(line => line.startsWith('<') || line.startsWith('\u0060'.repeat(3))));
  assert.ok(!md.includes('SHOULD-NOT-LEAK'));
  assert.ok(md.includes('\u0060\u0060 "[open](javascript:alert(1))\u0060after.csv" \u0060\u0060'));
});

test('both exports reject nondecimal payloads instead of treating them as trusted amounts', () => {
  const report = exportReport([], [['A', '1', 'x']]);
  report.rows[0].delta = '=HYPERLINK("https://evil.example")';
  assert.throws(() => renderChangesCSV(report), /exact decimal strings/);
  assert.throws(() => renderMarkdown(report), /exact decimal strings/);
  report.rows[0].delta = '1';
  report.rows[0].after = '<script>alert(1)</script>';
  assert.throws(() => renderChangesCSV(report), /exact decimal strings/);
  assert.throws(() => renderMarkdown(report), /exact decimal strings/);
});

test('grouped exports reject invalid counts and all exports reject unknown statuses', () => {
  const report = exportReport([], [['A', '1', 'x']], { aggregate: true });
  report.rows[0].beforeCount = '=1+1';
  assert.throws(() => renderChangesCSV(report), /integer row counts/);
  assert.throws(() => renderMarkdown(report), /integer row counts/);
  report.rows[0].beforeCount = 0;
  report.rows[0].status = '<script>';
  assert.throws(() => renderChangesCSV(report), /known reconciliation status/);
  assert.throws(() => renderMarkdown(report), /known reconciliation status/);
});

test('exports leave a deeply frozen report unchanged', () => {
  const report = exportReport([['A', '1.00', 'x']], [['A', '1.25', 'y'], ['B', '-10.20', 'z']]);
  const snapshot = JSON.stringify(report);
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(report);
  renderChangesCSV(report);
  renderMarkdown(report);
  assert.equal(JSON.stringify(report), snapshot);
});


test('Markdown splits matched changes into increases and decreases', () => {
  const report = exportReport(
    [['Atlas', '32000.00', 'x'], ['Cedar', '18000.00', 'x'], ['Same', '1', 'x']],
    [['Atlas', '40000.00', 'y'], ['Cedar', '10400.00', 'y'], ['Same', '1', 'y']],
  );
  const md = renderMarkdown(report);
  // The change-type table still adds up to the difference; the split is a separate table.
  const changeTable = md.split('\n\n').find(block => block.startsWith('| Change type'));
  assert.deepEqual(changeTable.split('\n').slice(2).map(line => line.split(' | ')[0]), ['| added', '| removed', '| changed', '| unchanged']);
  assert.ok(md.includes('| changed | 2 | 400.00 |'));
  assert.ok(md.includes('| Changed values by direction | Rows | Contribution to difference |\n| --- | ---: | ---: |\n| increases | 1 | 8000.00 |\n| decreases | 1 | -7600.00 |'));
  const none = renderMarkdown(exportReport([['A', '1', 'x']], [['A', '1', 'y']]));
  assert.ok(none.includes('| increases | 0 | 0 |'));
  assert.ok(none.includes('| decreases | 0 | 0 |'));
  assert.throws(() => renderMarkdown({ ...report, scale: 13 }), /decimal scale/);
});
