import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  parseCSV, reconcile, formatDecimal, MAX_ROWS, MAX_TEXT_BYTES,
  decodeText, detectDelimiter, inspectMapping, isExactDecimal, summarizeMovement, findSimilarKeys,
} from '../src/engine.mjs';

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

test('explicit group sums reconcile billing lines and distinguish source rows from groups', () => {
  const report = compare(
    'account,service,amount,note\nA,api,0.10,first\nA,api,0.20,second\nA,storage,10.000,base\nA,storage,-2.50,credit\nB,api,-5.00,credit\nB,api,-1,credit\nZ,api,0.00,zero\nU,api,4,offset\nU,api,-4.000,offset',
    'account,service,amount,note\nA,storage,3.25,new\nA,api,0.15,new\nA,api,0.30,new\nA,storage,4.25,new\nU,api,0,new\nN,api,-2,new\nN,api,-1,new\nNZ,api,0,new',
    { keys: ['account', 'service'], aggregate: true },
  );
  assert.equal(report.aggregation, 'sum');
  assert.equal(report.scale, 3);
  assert.deepEqual(report.sourceCounts, { before: 9, after: 8 });
  assert.deepEqual(report.counts, { before: 5, after: 5, added: 2, removed: 2, changed: 1, unchanged: 2 });
  assert.deepEqual(report.totals, { before: '1.800', after: '4.950', delta: '3.150', added: '-3.000', removed: '6.000', changed: '0.150' });
  assert.deepEqual(report.rows, [
    { key: ['A', 'api'], before: '0.300', after: '0.450', delta: '0.150', status: 'changed', beforeCount: 2, afterCount: 2 },
    { key: ['A', 'storage'], before: '7.500', after: '7.500', delta: '0.000', status: 'unchanged', beforeCount: 2, afterCount: 2 },
    { key: ['B', 'api'], before: '-6.000', after: null, delta: '6.000', status: 'removed', beforeCount: 2, afterCount: 0 },
    { key: ['Z', 'api'], before: '0.000', after: null, delta: '0.000', status: 'removed', beforeCount: 1, afterCount: 0 },
    { key: ['U', 'api'], before: '0.000', after: '0.000', delta: '0.000', status: 'unchanged', beforeCount: 2, afterCount: 1 },
    { key: ['N', 'api'], before: null, after: '-3.000', delta: '-3.000', status: 'added', beforeCount: 0, afterCount: 2 },
    { key: ['NZ', 'api'], before: null, after: '0.000', delta: '0.000', status: 'added', beforeCount: 0, afterCount: 1 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('group sums may exceed the input digit limit without losing fractional precision', () => {
  const large = '999999999999999999999999999999.000000000001';
  const report = compare(
    `account,amount\na,${large}\na,${large}`,
    `account,amount\na,0.000000000001\na,${large}\na,${large}`,
    { aggregate: true },
  );
  assert.equal(report.rows[0].before, '1999999999999999999999999999998.000000000002');
  assert.equal(report.rows[0].after, '1999999999999999999999999999998.000000000003');
  assert.equal(report.totals.delta, '0.000000000001');
  assert.equal(report.totals.changed, '0.000000000001');
  assert.equal(report.rows[0].beforeCount, 2);
  assert.equal(report.rows[0].afterCount, 3);
});

test('group identity preserves composite boundaries and exact IDs', () => {
  const report = compare(
    'first,second,amount\na|b,c,1.00\na,b|c,2\na|b,c,3\n__proto__,constructor,4\n001,x,5\n1,x,6\n spaced ,x,7',
    'first,second,amount\na,b|c,1.5\na|b,c,4\na,b|c,0.50\n__proto__,constructor,4\n001,x,5\n1,x,6\n spaced ,x,7',
    { keys: ['first', 'second'], aggregate: true },
  );
  assert.deepEqual(report.rows.map(row => row.key), [['a|b', 'c'], ['a', 'b|c'], ['__proto__', 'constructor'], ['001', 'x'], ['1', 'x'], [' spaced ', 'x']]);
  assert.deepEqual(report.counts, { before: 6, after: 6, added: 0, removed: 0, changed: 0, unchanged: 6 });
  assert.equal(report.totals.before, '28.00');
  assert.equal(report.totals.after, '28.00');
  assert.equal(report.rows[0].beforeCount, 2);
  assert.equal(report.rows[1].afterCount, 2);
});

test('aggregation validates every source value and key instead of dropping bad duplicate lines', () => {
  const empty = csv('account,amount');
  for (const value of ['', ' ', '1e3', '1,000', '=1+1', '1'.repeat(31), '0.0000000000001']) {
    const invalid = { headers: ['account', 'amount'], rows: [['a', '1'], ['a', value]] };
    assert.throws(() => reconcile(invalid, empty, { aggregate: true }), /Before CSV record 3/);
    assert.throws(() => reconcile(empty, invalid, { aggregate: true }), /After CSV record 3/);
  }
  assert.throws(() => compare('account,service,amount\na,x,1\na, ,2', 'account,service,amount', { keys: ['account', 'service'], aggregate: true }), /blank key/);
  assert.throws(() => compare('account,amount', 'account,total\na,1', { aggregate: true }), /missing column "amount"/);
  for (const aggregate of ['sum', 'true', 1, 0, null, {}, []]) {
    assert.throws(() => reconcile(empty, empty, { aggregate }), /aggregate option must be a boolean/);
  }
});

test('aggregation is opt-in and default report shape remains compatible', () => {
  const unique = csv('account,amount\na,1');
  const implicit = reconcile(unique, unique);
  assert.deepEqual(reconcile(unique, unique, { aggregate: false }), implicit);
  assert.equal(Object.hasOwn(implicit, 'aggregation'), false);
  assert.equal(Object.hasOwn(implicit, 'sourceCounts'), false);
  assert.equal(Object.hasOwn(implicit.rows[0], 'beforeCount'), false);
  assert.equal(Object.hasOwn(implicit.rows[0], 'afterCount'), false);
  const duplicate = csv('account,amount\na,1\na,2');
  assert.throws(() => reconcile(duplicate, unique), /duplicate key/);
  assert.throws(() => reconcile(unique, duplicate, { aggregate: false }), /duplicate key/);
});

test('empty and one-sided group reports retain counts, zero presence, and source immutability', () => {
  const empty = csv('account,amount');
  const before = csv('account,amount\na,1.000000000001\na,-1.000000000001');
  const options = { keys: ['account'], value: 'amount', aggregate: true };
  const snapshot = JSON.stringify({ before, empty, options });
  const report = reconcile(before, empty, options);
  assert.deepEqual(report.sourceCounts, { before: 2, after: 0 });
  assert.deepEqual(report.counts, { before: 1, after: 0, added: 0, removed: 1, changed: 0, unchanged: 0 });
  assert.deepEqual(report.rows[0], { key: ['a'], before: '0.000000000000', after: null, delta: '0.000000000000', status: 'removed', beforeCount: 2, afterCount: 0 });
  const added = reconcile(empty, before, options);
  assert.equal(added.rows[0].status, 'added');
  assert.equal(added.rows[0].afterCount, 2);
  const noGroups = reconcile(empty, empty, options);
  assert.deepEqual(noGroups.sourceCounts, { before: 0, after: 0 });
  assert.deepEqual(noGroups.counts, { before: 0, after: 0, added: 0, removed: 0, changed: 0, unchanged: 0 });
  assert.deepEqual(noGroups.totals, { before: '0', after: '0', delta: '0', added: '0', removed: '0', changed: '0' });
  report.keys.push('extra');
  report.rows[0].key[0] = 'changed';
  assert.equal(JSON.stringify({ before, empty, options }), snapshot);
});

test('text decoding is strict and reads Korean Excel (EUC-KR / CP949) exports explicitly', () => {
  const korean = Buffer.from([0xb0, 0xed, 0xb0, 0xb4, 0x2c, 0xb8, 0xc5, 0xc3, 0xe2]); // "고객,매출" in CP949
  assert.equal(decodeText(korean, 'euc-kr'), '고객,매출');
  assert.equal(decodeText(Buffer.from('\uFEFFaccount,amount', 'utf8')), 'account,amount');
  assert.throws(() => decodeText(korean), /not valid UTF-8/);
  assert.throws(() => decodeText(Buffer.from([0x61, 0xff, 0xff]), 'euc-kr'), /not valid EUC-KR/);
  for (const encoding of ['latin1', 'utf8', '', null]) assert.throws(() => decodeText(korean, encoding), /Unsupported text encoding/);
});

test('EUC-KR decoding covers the whole CP949 table, not only KS X 1001', () => {
  // Extended Hangul and symbols that ICU's plain EUC-KR converter rejects or changes.
  const samples = [[[0x8c, 0x63], '똠'], [[0x81, 0x41], '갂'], [[0xc1, 0x64], '햏'], [[0x94, 0xee], '뷁'], [[0xa2, 0xe6], '€'], [[0xa2, 0xe7], '®'], [[0xb0, 0xa1], '가']];
  for (const [bytes, text] of samples) assert.equal(decodeText(Uint8Array.from(bytes), 'euc-kr'), text);
  assert.equal(decodeText(Uint8Array.of(0x61, 0x8c, 0x63, 0x2c, 0x31).buffer, 'euc-kr'), 'a똠,1', 'ArrayBuffer input works too.');
  for (const bytes of [[0x80], [0xff], [0x8c], [0xc9, 0xa1], [0xfe, 0xa1], [0xc7, 0x41], [0x81, 0x5b], [0xc6, 0x53], [0xef, 0xbb, 0xbf, 0x61]]) {
    assert.throws(() => decodeText(Uint8Array.from(bytes), 'euc-kr'), /EUC-KR/, bytes.join(','));
  }
  assert.throws(() => decodeText(Buffer.from('\uFEFFa', 'utf8'), 'euc-kr'), /byte order mark/);
  // Every two-byte sequence, hashed, matches the WHATWG index as decoded by Chromium.
  const cells = [];
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x41; trail <= 0xfe; trail += 1) {
      try { cells.push(decodeText(Uint8Array.of(lead, trail), 'euc-kr')); } catch { cells.push(''); }
    }
  }
  assert.equal(cells.filter(Boolean).length, 17048);
  assert.equal(new Set(cells.filter(cell => cell >= '\uac00' && cell <= '\ud7a3')).size, 11172);
  assert.equal(createHash('sha256').update(cells.join('|')).digest('hex'), 'e1ba55e7d9672fb3c1a3323902a83f0434301b5317c37b6b4dda28da2fabedcf');
});

test('delimiter detection checks the header against the first records and ignores quoted separators', () => {
  assert.equal(detectDelimiter('account;amount\nA;1,5'), ';');
  assert.equal(detectDelimiter('account\tamount\nA\t1'), '\t');
  assert.equal(detectDelimiter('\uFEFF\r\n\naccount,amount;x\n'), ',');
  assert.equal(detectDelimiter('"a;b;c",amount\n'), ',');
  assert.equal(detectDelimiter('"a,b";amount\n'), ';');
  assert.equal(detectDelimiter('a,b;c\n'), ',', 'Ties keep the comma default.');
  assert.equal(detectDelimiter('account'), ',');
  assert.equal(detectDelimiter(''), ',');
  // A separator that splits every sampled record like the header beats header counts alone.
  assert.equal(detectDelimiter('account,Amount (KRW; net; VAT excl.)\nA,100\nB,200\n'), ',');
  assert.equal(detectDelimiter('id,note,amount\n1,a;b,5\n'), ',');
  assert.equal(detectDelimiter('name\tamount\nKim, Lee\t5\n'), '\t');
  assert.equal(detectDelimiter('a;b;c,d\r\n1;2;3,4\r\n\r\n5;6;7,8'), ';');
  assert.equal(detectDelimiter('a;b\n"x\ny";1\n'), ';', 'Quoted line breaks stay inside a record.');
  assert.equal(detectDelimiter('a,b;c;d\n1;2\n3,4;5;6'), ';', 'Without a consistent candidate, header counts decide.');
  assert.throws(() => detectDelimiter(null), /string/);
});

test('input errors name the offending value and count every problem in the file', () => {
  const empty = csv('account,amount');
  assert.throws(
    () => reconcile(csv('account,amount\na,1\nb,"1,000"\nc,\nd,1e3'), empty),
    /^Error: Before CSV record 3, column "amount" must be a decimal number .*; found "1,000"\. 2 more values in this column are invalid\.$/,
  );
  assert.throws(() => reconcile(empty, csv('account,amount\na,x')), /After CSV record 2, .*found "x"\.$/);
  assert.throws(() => reconcile(csv('account,amount\na,1\na,2\nb,3\nb,4\na,5'), empty), /record 3 has duplicate key \["a"\]\. 2 more records repeat keys\./);
  assert.throws(() => reconcile(csv('account,amount\n ,1\n,2'), empty), /record 2 has a blank key\. 1 more record has a blank key\./);
  const long = 'x'.repeat(80);
  assert.throws(() => reconcile({ headers: ['account', 'amount'], rows: [['a', long]] }, empty), new RegExp(`found "${'x'.repeat(39)}…"`));
  // Control, bidi, and invisible characters from cells are shown as escapes, and truncation keeps whole characters.
  assert.throws(() => reconcile(csv('account,amount\na,1\u009b2\u202e'), empty), (error) => error.message.includes('found "1\\u009b2\\u202e"') && !/[\u009b\u202e]/.test(error.message));
  assert.throws(() => reconcile(csv('account,amount\n"a\u202e",1\n"a\u202e",2'), empty), /duplicate key \["a\\u202e"\]/);
  assert.throws(() => reconcile({ headers: ['account', 'amount'], rows: [['a', `${'x'.repeat(38)}😀😀😀`]] }, empty), new RegExp(`found "${'x'.repeat(38)}😀…"`));
});

test('mapping inspection previews the same checks without throwing for data problems', () => {
  const dataset = csv('account,service,amount\na,x,1\na,y,2\na,x,oops\n ,x,3\nb,x,"1,200.00"');
  const rows = inspectMapping(dataset, { keys: ['account'], value: 'amount' });
  assert.equal(rows.rows, 5);
  assert.deepEqual(rows.missing, []);
  assert.deepEqual(rows.blankKeys, { count: 1, examples: [{ record: 5, key: [' '] }] });
  assert.deepEqual(rows.duplicateKeys, { count: 2, examples: [{ record: 3, key: ['a'] }, { record: 4, key: ['a'] }] });
  assert.equal(rows.invalidValues.count, 2);
  assert.deepEqual(rows.invalidValues.examples.map(example => [example.record, example.value]), [[4, 'oops'], [6, '1,200.00']]);
  const composite = inspectMapping(dataset, { keys: ['account', 'service'], value: 'amount' });
  assert.equal(composite.duplicateKeys.count, 1);
  const grouped = inspectMapping(dataset, { keys: ['account'], value: 'amount', aggregate: true });
  assert.equal(grouped.duplicateKeys.count, 0);
  assert.equal(grouped.keys, 2);
  assert.deepEqual(inspectMapping(dataset, { keys: ['missing'], value: 'total' }).missing, ['missing', 'total']);
  assert.throws(() => inspectMapping(dataset, { keys: [], value: 'amount' }), /key columns/);
  assert.throws(() => inspectMapping(null, { keys: ['account'], value: 'amount' }), /parsed CSV/);
  assert.throws(() => inspectMapping({ headers: ['account', 'amount'], rows: [['a']] }, { keys: ['account'], value: 'amount' }), /record 2 must have 2 string fields/);
});

test('exact decimal checks match the comparison rules', () => {
  for (const value of ['0', '-0.00', '12.50', '1'.repeat(30), '0.000000000001']) assert.equal(isExactDecimal(value), true, value);
  for (const value of ['', ' 1', '1,000', '+1', '.5', '1e3', '1'.repeat(31), '0.0000000000001', null, 1]) assert.equal(isExactDecimal(value), false, String(value));
});

test('movement summary splits offsetting changes and measures concentration exactly', () => {
  const read = name => parseCSV(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));
  const report = reconcile(read('before.csv'), read('after.csv'));
  assert.deepEqual(summarizeMovement(report), {
    increased: { count: 1, total: '8000.00' },
    decreased: { count: 1, total: '-7600.00' },
    gross: '44600.00',
    moving: 5,
    largest: { count: 3, total: '29000.00', percent: '65.0' },
  });
  const tiny = compare('account,amount\na,100\nb,100\nc,0.01', 'account,amount\na,200\nb,0\nc,0.02');
  assert.deepEqual(summarizeMovement(tiny, 2).largest, { count: 2, total: '200.00', percent: '99.9' }, 'Shares round down.');
  const same = compare('account,amount\na,1', 'account,amount\na,1.0');
  assert.deepEqual(summarizeMovement(same), {
    increased: { count: 0, total: '0.0' }, decreased: { count: 0, total: '0.0' }, gross: '0.0', moving: 0,
    largest: { count: 0, total: '0.0', percent: null },
  });
});

test('similar-key hints pair added and removed keys without changing exact matching', () => {
  const report = compare(
    'account,region,amount\nGrove ,KR,1\nAtlas,US,2\nCedar,EU,3\nBirch,EU,4',
    'account,region,amount\ngrove,KR,1\nＡｔｌａｓ,US,2\nCedar,eu ,3\nPine,EU,4',
    { keys: ['account', 'region'] },
  );
  assert.equal(report.counts.added, 4);
  assert.equal(report.counts.removed, 4);
  const similar = findSimilarKeys(report);
  assert.equal(similar.count, 3);
  assert.deepEqual(similar.examples[0], { removed: ['Grove ', 'KR'], added: ['grove', 'KR'] });
  assert.equal(findSimilarKeys(report, 1).examples.length, 1);
  assert.deepEqual(findSimilarKeys(compare('account,amount\na,1', 'account,amount\nb,1')), { count: 0, examples: [] });
});
