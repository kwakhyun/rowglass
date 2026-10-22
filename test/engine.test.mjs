import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, reconcile, formatDecimal, MAX_ROWS, MAX_TEXT_BYTES } from '../src/engine.mjs';

const csv = (source) => parseCSV(source);
const compare = (before, after, options) => reconcile(csv(before), csv(after), options);

test('reconciliation explains known totals and each contribution exactly', () => {
  const report = compare(
    'account,amount,note\n001,100.10,old\n002,40.20,removed\n003,0,zero\n004,-5.50,credit\n005,10.00,same',
    'note,amount,account,extra\nupdated,110.15,001,x\nzero,0.00,003,x\ncredit,-2.50,004,x\nnew note,10,005,x\nnew,20.25,006,x',
  );
  assert.deepEqual(report.totals, { before: '144.80', after: '137.90', delta: '-6.90', added: '20.25', removed: '-40.20', changed: '13.05' });
  assert.deepEqual(report.counts, { before: 5, after: 5, added: 1, removed: 1, changed: 2, unchanged: 2 });
  assert.deepEqual(report.schema, { added: ['extra'], removed: [] });
  assert.deepEqual(report.rows, [
    { key: ['001'], before: '100.10', after: '110.15', delta: '10.05', status: 'changed' },
    { key: ['002'], before: '40.20', after: null, delta: '-40.20', status: 'removed' },
    { key: ['003'], before: '0.00', after: '0.00', delta: '0.00', status: 'unchanged' },
    { key: ['004'], before: '-5.50', after: '-2.50', delta: '3.00', status: 'changed' },
    { key: ['005'], before: '10.00', after: '10.00', delta: '0.00', status: 'unchanged' },
    { key: ['006'], before: null, after: '20.25', delta: '20.25', status: 'added' },
  ]);
  assert.equal(report.version, 1);
  assert.equal(report.scale, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('decimal arithmetic does not lose fractional cents or large integer precision', () => {
  const report = compare(
    'account,amount\na,0.1\nb,0.2\nc,999999999999999999999999999999.000000000001',
    'account,amount\na,0.2\nb,0.3\nc,999999999999999999999999999999.000000000002',
  );
  assert.equal(report.totals.before, '999999999999999999999999999999.300000000001');
  assert.equal(report.totals.after, '999999999999999999999999999999.500000000002');
  assert.equal(report.totals.delta, '0.200000000001');
  assert.equal(report.totals.changed, '0.200000000001');
  assert.equal(report.rows[2].delta, '0.000000000001');
});

test('all-negative values, removal of a credit, and zero presence keep correct signs', () => {
  const report = compare('account,amount\ncredit,-7.00\nzero,-0.00\nkeep,-2', 'account,amount\nkeep,-5\nnew,-3\nadded-zero,0');
  assert.deepEqual(report.totals, { before: '-9.00', after: '-8.00', delta: '1.00', added: '-3.00', removed: '7.00', changed: '-3.00' });
  assert.deepEqual(report.counts, { before: 3, after: 3, added: 2, removed: 2, changed: 1, unchanged: 0 });
  assert.equal(report.rows[1].before, '0.00');
  assert.equal(report.rows[1].status, 'removed');
  assert.equal(report.rows[4].status, 'added');
});

test('row ordering and nonmetric edits do not create metric changes', () => {
  const report = compare('account,amount,note,old\na,1.0,hello,x\nb,2.00,world,x', 'note,account,amount,new\nchanged,b,2,z\nchanged,a,01.00,z');
  assert.deepEqual(report.rows.map((row) => row.key), [['a'], ['b']]);
  assert.equal(report.counts.changed, 0);
  assert.equal(report.counts.unchanged, 2);
  assert.equal(report.totals.delta, '0.00');
  assert.deepEqual(report.schema, { added: ['new'], removed: ['old'] });
});

test('composite keys cannot collide on a separator, quotes, or object property names', () => {
  const report = compare(
    'first,second,amount\na|b,c,1\na,b|c,2\n__proto__,constructor,3\n"[\"\"x\"\"]","x,y",4',
    'first,second,amount\na,b|c,20\na|b,c,10\n__proto__,constructor,3\n"[\"\"x\"\"]","x,y",4',
    { keys: ['first', 'second'], value: 'amount' },
  );
  assert.equal(report.counts.before, 4);
  assert.equal(report.counts.changed, 2);
  assert.equal(report.totals.delta, '27');
  assert.deepEqual(report.rows[0].key, ['a|b', 'c']);
  assert.deepEqual(report.rows[1].key, ['a', 'b|c']);
});

test('keys and source names preserve IDs and untrusted strings as inert data', () => {
  const beforeName = '<img src=x onerror=alert(1)>.csv';
  const afterName = '=HYPERLINK("https://example.com")';
  const report = compare('account,amount\n001,1\n<script>alert(1)</script>,2\n=1+1,3\n spaced ,4', 'account,amount\n001,1\n<script>alert(1)</script>,2\n=1+1,3\n spaced ,4', { beforeName, afterName });
  assert.equal(report.beforeName, beforeName);
  assert.equal(report.afterName, afterName);
  assert.deepEqual(report.rows.map((row) => row.key[0]), ['001', '<script>alert(1)</script>', '=1+1', ' spaced ']);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('header-only datasets and one-sided datasets are valid', () => {
  const empty = compare('account,amount\n', 'account,amount');
  assert.deepEqual(empty.totals, { before: '0', after: '0', delta: '0', added: '0', removed: '0', changed: '0' });
  assert.equal(empty.rows.length, 0);
  const added = compare('account,amount', 'account,amount\na,1.25');
  assert.equal(added.totals.added, '1.25');
  assert.equal(added.rows[0].before, null);
  const removed = compare('account,amount\na,1.25', 'account,amount');
  assert.equal(removed.totals.removed, '-1.25');
  assert.equal(removed.rows[0].after, null);
});

test('duplicates, blank keys, unavailable columns, and invalid choices fail clearly', () => {
  const valid = csv('account,amount\na,1');
  assert.throws(() => reconcile(csv('account,amount\na,1\na,2'), valid), /duplicate key/);
  assert.throws(() => reconcile(valid, csv('account,amount\na,1\na,2')), /duplicate key/);
  assert.throws(() => reconcile(csv('account,amount\n ,1'), valid), /blank key/);
  assert.throws(() => reconcile(csv('account,amount\n,1'), valid), /blank key/);
  assert.throws(() => reconcile(valid, csv('account,total\na,1')), /missing column "amount"/);
  assert.throws(() => reconcile(valid, valid, { keys: [] }), /key columns/);
  assert.throws(() => reconcile(valid, valid, { keys: ['account', 'account'] }), /key columns/);
  assert.throws(() => reconcile(valid, valid, { value: '' }), /value column/);
  assert.throws(() => reconcile(valid, { headers: ['account', 'amount'], rows: [['a', 1]] }), /string fields/);
});

test('numbers reject blanks, exponents, grouping, whitespace and unsupported precision', () => {
  const empty = csv('account,amount');
  for (const value of ['', ' ', ' 1', '1 ', '1e3', '1E-3', '+1', '.1', '1.', 'NaN', 'Infinity', '1,000', '1_000', '0x10', '--1', '１２', '=1+1']) {
    assert.throws(() => reconcile({ headers: ['account', 'amount'], rows: [['a', value]] }, empty), /decimal number/, JSON.stringify(value));
  }
  assert.throws(() => reconcile({ headers: ['account', 'amount'], rows: [['a', '1'.repeat(31)]] }, empty), /30 integer digit/);
  assert.throws(() => reconcile({ headers: ['account', 'amount'], rows: [['a', '0.0000000000001']] }, empty), /12 decimal place/);
});

test('CSV preserves BOM-stripped headers, CRLF, commas, multiline quotes and escaped quotes', () => {
  assert.deepEqual(csv('\uFEFFaccount,note,amount\r\na,"Hello, \"\"world\"\"\r\nsecond line",1.25\r\nb,,2\r\n'), {
    headers: ['account', 'note', 'amount'],
    rows: [['a', 'Hello, "world"\r\nsecond line', '1.25'], ['b', '', '2']],
  });
  assert.deepEqual(parseCSV('key;amount\na;1', { delimiter: ';' }), { headers: ['key', 'amount'], rows: [['a', '1']] });
  assert.deepEqual(parseCSV('key\tamount\na\t1', { delimiter: '\t' }).rows, [['a', '1']]);
});

test('CSV skips empty physical lines but retains quoted empty and whitespace records', () => {
  assert.deepEqual(csv('\n\r\nkey\r\n\r\n""\r\n \r\n"a\n\nb"\n\n'), { headers: ['key'], rows: [[''], [' '], ['a\n\nb']] });
  assert.deepEqual(csv('a,b\nx,').rows, [['x', '']]);
});

test('malformed CSV fails instead of silently repairing data', () => {
  for (const source of ['', '\r\n', ',amount', ' ,amount', 'account,account', '"",amount']) assert.throws(() => csv(source), /header/);
  for (const source of ['a,b\nx', 'a,b\nx,y,z']) assert.throws(() => csv(source), /fields/);
  for (const source of ['a\n"open', 'a\nun"quoted', 'a\n"closed"tail', 'a\n"closed" ']) assert.throws(() => csv(source), /quot/);
  for (const delimiter of ['', ',,', '"', '\n', '\r', '\0']) assert.throws(() => parseCSV('a', { delimiter }), /delimiter/);
  assert.throws(() => parseCSV(null), /string/);
});

test('CSV limits apply to data records and UTF-8 bytes, including multibyte text', () => {
  const atLimit = 'account\n' + 'a\n'.repeat(MAX_ROWS);
  assert.equal(csv(atLimit).rows.length, MAX_ROWS);
  assert.throws(() => csv(atLimit + 'a'), /100,000 row/);
  const unicodeTooLarge = 'name\n' + '가'.repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1);
  assert.ok(unicodeTooLarge.length < MAX_TEXT_BYTES);
  assert.throws(() => csv(unicodeTooLarge), /20 MiB/);
});

test('formatting retains exact scale and normalizes negative zero', () => {
  assert.equal(formatDecimal(-5n, 3), '-0.005');
  assert.equal(formatDecimal(0n, 12), '0.000000000000');
  assert.equal(formatDecimal(100n, 2), '1.00');
  assert.throws(() => formatDecimal(1, 2), /BigInt/);
  assert.throws(() => formatDecimal(1n, 13), /scale/);
});

test('input datasets and options are not mutated', () => {
  const before = csv('account,amount\na,1');
  const after = csv('account,amount\na,2');
  const options = { keys: ['account'], value: 'amount' };
  const snapshot = JSON.stringify({ before, after, options });
  const report = reconcile(before, after, options);
  report.keys.push('extra');
  report.rows[0].key[0] = 'changed';
  assert.equal(JSON.stringify({ before, after, options }), snapshot);
});
