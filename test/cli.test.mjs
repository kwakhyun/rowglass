import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseCSV } from '../src/engine.mjs';

const cli = fileURLToPath(new URL('../bin/rowglass.mjs', import.meta.url));
const beforeCSV = 'account,region,amount\nalpha,us,100.10\nbeta,eu,20.20\nremoved,eu,7.00\n';
const afterCSV = 'account,region,amount\nalpha,us,110.20\nbeta,eu,20.20\nadded,us,5.00\n';

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rowglass-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(dir, 'before.csv'), beforeCSV),
    writeFile(join(dir, 'after.csv'), afterCSV),
  ]);
  return dir;
}

const compare = ['before.csv', 'after.csv', '--key', 'account', '--value', 'amount', '--out', 'report.html'];

test('writes a standalone HTML report and parseable JSON from real CSV files', async t => {
  const dir = await fixture(t);
  const result = run([...compare, '--json', 'report.json'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 added, 1 removed, 1 changed, 1 unchanged/);
  assert.match(await readFile(join(dir, 'report.html'), 'utf8'), /<!doctype html>/i);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.counts.added, 1);
  assert.equal(report.counts.removed, 1);
  assert.equal(report.counts.changed, 1);
  assert.equal(report.counts.unchanged, 1);
  assert.equal(report.beforeName, 'before.csv');
  assert.equal(report.afterName, 'after.csv');
  assert.equal(report.totals.before, '127.30');
  assert.equal(report.totals.after, '135.40');
  assert.equal(report.totals.delta, '8.10');
  assert.equal(await readFile(join(dir, 'before.csv'), 'utf8'), beforeCSV);
});

test('--fail-on-change writes its report and exits 2 for changes', async t => {
  const dir = await fixture(t);
  const result = run([...compare, '--fail-on-change'], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.ok(existsSync(join(dir, 'report.html')));
});

test('--fail-on-change succeeds for equivalent numeric values and reordered rows', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'after.csv'), 'account,region,amount\nbeta,eu,20.200\nremoved,eu,7\nalpha,us,100.1\n');
  const result = run([...compare, '--fail-on-change'], dir);
  assert.equal(result.status, 0, result.stderr);
});

test('added and removed zero-value rows still trigger --fail-on-change', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account,amount\nremoved,0\n');
  await writeFile(join(dir, 'after.csv'), 'account,amount\nadded,0\n');
  const result = run([...compare, '--fail-on-change'], dir);
  assert.equal(result.status, 2, result.stderr);
});

test('existing outputs require --force', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'report.html');
  await writeFile(path, 'KEEP');
  const refused = run(compare, dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(await readFile(path, 'utf8'), 'KEEP');
  const forced = run([...compare, '--force'], dir);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(await readFile(path, 'utf8'), /<!doctype html>/i);
});

test('neither HTML nor JSON may overwrite an input, even with --force', async t => {
  const dir = await fixture(t);
  const sameInput = [...compare.slice(0, -1), './before.csv', '--force'];
  assert.equal(run(sameInput, dir).status, 1);
  const jsonInput = [...compare, '--json', resolve(dir, 'after.csv'), '--force'];
  assert.equal(run(jsonInput, dir).status, 1);
  assert.equal(await readFile(join(dir, 'before.csv'), 'utf8'), beforeCSV);
  assert.equal(await readFile(join(dir, 'after.csv'), 'utf8'), afterCSV);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

test('hard-linked inputs cannot be used as output targets', async t => {
  const dir = await fixture(t);
  await link(join(dir, 'before.csv'), join(dir, 'report.html'));
  const result = run([...compare, '--force'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /input file/);
  assert.equal(await readFile(join(dir, 'before.csv'), 'utf8'), beforeCSV);
});

test('symbolic link outputs are rejected', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'unrelated.txt'), 'KEEP');
  await symlink(join(dir, 'unrelated.txt'), join(dir, 'report.html'));
  const result = run([...compare, '--force'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symbolic link/);
  assert.equal(await readFile(join(dir, 'unrelated.txt'), 'utf8'), 'KEEP');
});

test('output paths that resolve through a directory symlink cannot replace inputs', { skip: process.platform === 'win32' }, async t => {
  const dir = await fixture(t);
  await symlink(dir, join(dir, 'alias'));
  const result = run([...compare.slice(0, -1), 'alias/before.csv', '--force'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /input file/);
});

test('HTML and JSON output paths must be distinct', async t => {
  const dir = await fixture(t);
  const result = run([...compare, '--json', './report.html'], dir);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

test('all output targets are checked before creating a report', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'report.json'), 'KEEP');
  const result = run([...compare, '--json', 'report.json'], dir);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, 'report.html')), false);
  assert.equal(await readFile(join(dir, 'report.json'), 'utf8'), 'KEEP');
});

test('strict argument validation never creates an output', async t => {
  const dir = await fixture(t);
  const cases = [
    [...compare, '--unknown'],
    [...compare, '--json'],
    [...compare, '--csv'],
    [...compare, '--markdown'],
    [...compare, '--group-by'],
    [...compare, '--group-by', 'region'],
    [...compare, '--csv', 'report.csv', '--csv', 'again.csv'],
    [...compare, '--markdown', 'report.md', '--markdown', 'again.md'],
    [...compare, '--delimiter', 'pipe'],
    [...compare, '--encoding', 'latin1'],
    [...compare, '--encoding', 'utf-8', '--encoding', 'euc-kr'],
    [...compare, '--encoding', 'cp949'],
    [...compare, '--encoding', 'euc-kr,'],
    [...compare, '--encoding', 'euc-kr,utf-8,utf-8'],
    ['app', '--out', 'report.html', '--encoding', 'euc-kr'],
    ['app', '--json', 'report.json'],
    ['before.csv', 'after.csv', '--key', 'account', '--value', 'amount'],
    [...compare, '--out', 'second.html'],
    [...compare, '--key', 'account'],
    [...compare, '--force', '--force'],
    ['before.csv', 'after.csv', '--value', 'amount', '--out', 'report.html'],
    ['before.csv', 'after.csv', '--key', 'account', '--out', 'report.html'],
    ['before.csv', '--key', 'account', '--value', 'amount', '--out', 'report.html'],
    ['app', '--out', 'report.html', '--json', 'report.json'],
    ['app', '--out', 'report.html', '--csv', 'report.csv'],
    ['app', '--out', 'report.html', '--markdown', 'report.md'],
    ['app', '--out', 'report.html', '--group-by', 'account'],
    ['app', '--out', 'report.html', '--fail-on-change'],
    ['demo', '--out', 'report.html', '--key', 'account'],
    ['demo', '--out', 'report.html', '--group-by', 'account'],
    ['before.csv', 'after.csv', '--group-by', 'account', '--group-by', 'account', '--value', 'amount', '--out', 'report.html'],
    ['app', '--out', 'report.html', 'unexpected.csv'],
    [],
  ];
  for (const args of cases) {
    const result = run(args, dir);
    assert.equal(result.status, 1, `Expected invalid arguments: ${JSON.stringify(args)}\n${result.stderr}`);
    assert.equal(existsSync(join(dir, 'report.html')), false);
    assert.equal(existsSync(join(dir, 'report.json')), false);
    assert.equal(existsSync(join(dir, 'report.csv')), false);
    assert.equal(existsSync(join(dir, 'report.md')), false);
  }
});

test('tab-delimited input and repeated keys work', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account\tregion\tamount\nalpha\tus\t1.10\nalpha\teu\t2.20\n');
  await writeFile(join(dir, 'after.csv'), 'account\tregion\tamount\nalpha\tus\t1.10\nalpha\teu\t3.30\n');
  const result = run([...compare, '--key', 'region', '--delimiter', 'tab'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 changed, 1 unchanged/);
});

test('invalid UTF-8 is rejected without output', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), Buffer.from([0x61, 0x2c, 0xc3, 0x28]));
  const result = run(compare, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UTF-8/);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

test('input size is checked before parsing', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), Buffer.alloc(20 * 1024 * 1024 + 1, 65));
  const result = run(compare, dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /20 MiB/);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

test('CSV validation failures do not create output', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account,amount\nalpha,not-a-number\n');
  const result = run(compare, dir);
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, 'report.html')), false);
});

test('app and demo work from an unrelated directory and create output directories', async t => {
  const dir = await fixture(t);
  const app = run(['app', '--out', 'nested/app.html'], dir);
  assert.equal(app.status, 0, app.stderr);
  assert.match(await readFile(join(dir, 'nested', 'app.html'), 'utf8'), /<!doctype html>/i);
  const demo = run(['demo', '--out', 'nested/demo.html', '--json', 'nested/demo.json'], dir);
  assert.equal(demo.status, 0, demo.stderr);
  assert.ok(JSON.parse(await readFile(join(dir, 'nested', 'demo.json'), 'utf8')).counts);
});

test('directory outputs are rejected', async t => {
  const dir = await fixture(t);
  await mkdir(join(dir, 'report.html'));
  const result = run([...compare, '--force'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular file/);
});

test('help and version are available without input files', async t => {
  const dir = await fixture(t);
  const help = run(['--help'], dir);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--fail-on-change/);
  const version = run(['--version'], dir);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.1.0');
});

test('CSV and Markdown exports are written with the complete report before exit 2', async t => {
  const dir = await fixture(t);
  const result = run([...compare, '--json', 'report.json', '--csv', 'report.csv', '--markdown', 'report.md', '--fail-on-change'], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /CSV:/);
  assert.match(result.stdout, /Markdown:/);
  const csv = parseCSV(await readFile(join(dir, 'report.csv'), 'utf8'));
  assert.equal(csv.rows.length, 3);
  assert.ok(csv.rows.some(row => row.includes('alpha')));
  assert.ok(csv.rows.some(row => row.includes('added')));
  assert.ok(csv.rows.some(row => row.includes('removed')));
  assert.ok(!csv.rows.some(row => row.includes('beta')));
  const markdown = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(markdown, /127\.30/);
  assert.match(markdown, /135\.40/);
  assert.match(markdown, /8\.10/);
  assert.ok(existsSync(join(dir, 'report.html')));
  assert.equal(JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')).counts.unchanged, 1);
});

test('demo supports CSV and Markdown output from an unrelated directory', async t => {
  const dir = await fixture(t);
  const result = run(['demo', '--out', 'demo.html', '--csv', 'demo.csv', '--markdown', 'demo.md'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseCSV(await readFile(join(dir, 'demo.csv'), 'utf8')).rows.length, 5);
  assert.match(await readFile(join(dir, 'demo.md'), 'utf8'), /before\.csv/);
});

test('every pair of output formats rejects duplicate target paths before writing', async t => {
  const dir = await fixture(t);
  const names = ['out', 'json', 'csv', 'markdown'];
  for (let first = 0; first < names.length; first += 1) {
    for (let second = first + 1; second < names.length; second += 1) {
      const args = compare.slice(0, -2);
      names.forEach((name, index) => args.push('--' + name, index === first || index === second ? './same.output' : `${name}.output`));
      const result = run([...args, '--force'], dir);
      assert.equal(result.status, 1, `Expected ${names[first]}/${names[second]} to collide: ${result.stderr}`);
      assert.match(result.stderr, /different output files/);
      assert.equal(existsSync(join(dir, 'same.output')), false);
      for (const name of names) assert.equal(existsSync(join(dir, `${name}.output`)), false);
    }
  }
});

test('CSV and Markdown cannot overwrite inputs, even with --force', async t => {
  const dir = await fixture(t);
  for (const option of ['--csv', '--markdown']) {
    const result = run([...compare, option, 'before.csv', '--force'], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /input file/);
    assert.equal(existsSync(join(dir, 'report.html')), false);
  }
  assert.equal(await readFile(join(dir, 'before.csv'), 'utf8'), beforeCSV);
});

test('existing supplemental outputs require --force and are checked before HTML is created', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'report.csv'), 'KEEP CSV');
  await writeFile(join(dir, 'report.md'), 'KEEP MARKDOWN');
  for (const [option, path] of [['--csv', 'report.csv'], ['--markdown', 'report.md']]) {
    const result = run([...compare, option, path], dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    assert.equal(existsSync(join(dir, 'report.html')), false);
  }
  const result = run([...compare, '--csv', 'report.csv', '--markdown', 'report.md', '--force'], dir);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(await readFile(join(dir, 'report.csv'), 'utf8'), 'KEEP CSV');
  assert.notEqual(await readFile(join(dir, 'report.md'), 'utf8'), 'KEEP MARKDOWN');
});

test('hard-linked output targets cannot be shared by two export formats', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'report.csv'), 'KEEP');
  await link(join(dir, 'report.csv'), join(dir, 'report.md'));
  const result = run([...compare, '--csv', 'report.csv', '--markdown', 'report.md', '--force'], dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different output files/);
  assert.equal(existsSync(join(dir, 'report.html')), false);
  assert.equal(await readFile(join(dir, 'report.csv'), 'utf8'), 'KEEP');
});

test('group-by sums duplicate rows with composite keys and reports source counts', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account,region,amount\nalpha,us,0.10\nalpha,us,0.20\nalpha,eu,1.00\n');
  await writeFile(join(dir, 'after.csv'), 'account,region,amount\nalpha,us,0.20\nalpha,us,0.30\nalpha,eu,0.50\nalpha,eu,0.50\n');
  const result = run(['before.csv', 'after.csv', '--group-by', 'account', '--group-by', 'region', '--value', 'amount', '--out', 'report.html', '--json', 'report.json', '--csv', 'report.csv', '--markdown', 'report.md', '--fail-on-change'], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /Groups: 0 added, 0 removed, 1 changed, 1 unchanged/);
  assert.match(result.stdout, /Source rows: 3 before, 4 after/);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.aggregation, 'sum');
  assert.deepEqual(report.sourceCounts, { before: 3, after: 4 });
  assert.equal(report.totals.delta, '0.20');
  assert.equal(report.counts.before, 2);
  assert.equal(report.counts.after, 2);
  assert.equal(parseCSV(await readFile(join(dir, 'report.csv'), 'utf8')).rows.length, 1);
});

test('group-by ignores source row count changes when the group sum is unchanged', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account,amount\nalpha,10.00\n');
  await writeFile(join(dir, 'after.csv'), 'account,amount\nalpha,4.00\nalpha,6.00\n');
  const strict = run(compare, dir);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /duplicate key/);
  const result = run(['before.csv', 'after.csv', '--group-by', 'account', '--value', 'amount', '--out', 'report.html', '--json', 'report.json', '--fail-on-change'], dir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.counts.changed, 0);
  assert.equal(report.counts.unchanged, 1);
  assert.equal(report.rows[0].beforeCount, 1);
  assert.equal(report.rows[0].afterCount, 2);
});

test('added and removed zero-sum groups still trigger --fail-on-change', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account,amount\nremoved,10\nremoved,-10\n');
  await writeFile(join(dir, 'after.csv'), 'account,amount\nadded,0\n');
  const result = run(['before.csv', 'after.csv', '--group-by', 'account', '--value', 'amount', '--out', 'report.html', '--fail-on-change'], dir);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /Groups: 1 added, 1 removed, 0 changed/);
});

test('Korean Excel exports need an explicit EUC-KR encoding', async t => {
  const dir = await fixture(t);
  // "고객,매출" header with Korean keys, encoded as CP949.
  const encode = rows => Buffer.concat([Buffer.from([0xb0, 0xed, 0xb0, 0xb4, 0x2c, 0xb8, 0xc5, 0xc3, 0xe2, 0x0a]), Buffer.from(rows)]);
  await writeFile(join(dir, 'before.csv'), encode([0xb0, 0xa1, 0x2c, 0x31, 0x0a])); // 가,1
  await writeFile(join(dir, 'after.csv'), encode([0xb0, 0xa1, 0x2c, 0x33, 0x0a])); // 가,3
  const args = ['before.csv', 'after.csv', '--key', '고객', '--value', '매출', '--json', 'report.json'];
  const refused = run(args, dir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Before input must be valid UTF-8: before\.csv\. After input must be valid UTF-8: after\.csv\..*Try --encoding euc-kr\.\n$/);
  assert.equal(existsSync(join(dir, 'report.json')), false);
  const result = run([...args, '--encoding', 'euc-kr'], dir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.deepEqual(report.rows[0], { key: ['가'], before: '1', after: '3', delta: '2', status: 'changed' });
  await writeFile(join(dir, 'before.csv'), Buffer.from([0x61, 0xff, 0xff]));
  const invalid = run([...args, '--encoding', 'euc-kr', '--force'], dir);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Before input must be valid EUC-KR \(CP949\): before\.csv\..*Try --encoding utf-8,euc-kr\./);
});

test('each input can use its own encoding, and a UTF-8 BOM is never read as EUC-KR', async t => {
  const dir = await fixture(t);
  // CP949 "고객,매출" with 똠 (0x8C63), an extended syllable outside KS X 1001.
  await writeFile(join(dir, 'before.csv'), Buffer.from([0xb0, 0xed, 0xb0, 0xb4, 0x2c, 0xb8, 0xc5, 0xc3, 0xe2, 0x0a, 0x8c, 0x63, 0x2c, 0x31, 0x0a]));
  await writeFile(join(dir, 'after.csv'), '\uFEFF고객,매출\n똠,4\n'); // Excel "CSV UTF-8"
  const args = ['before.csv', 'after.csv', '--key', '고객', '--value', '매출', '--json', 'report.json'];
  const both = run([...args, '--encoding', 'euc-kr'], dir);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /After input starts with a UTF-8 byte order mark, so it is UTF-8, not EUC-KR: after\.csv\..*Try --encoding euc-kr,utf-8\./);
  const result = run([...args, '--encoding', 'EUC-KR,utf-8'], dir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.deepEqual(report.rows, [{ key: ['똠'], before: '1', after: '4', delta: '3', status: 'changed' }]);
});

test('semicolon and automatically detected separators are supported', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'before.csv'), 'account;amount\nalpha;1.10\nbeta;2\n');
  await writeFile(join(dir, 'after.csv'), 'account\tamount\nalpha\t1.30\nbeta\t2\n');
  const base = ['before.csv', 'after.csv', '--key', 'account', '--value', 'amount', '--json', 'report.json', '--force'];
  const explicit = run([...base, '--delimiter', 'semicolon'], dir);
  assert.equal(explicit.status, 1, 'One explicit separator applies to both files.');
  assert.match(explicit.stderr, /After CSV after\.csv has one column when read as semicolon-separated, but its header looks tab-separated\. Add --delimiter tab or --delimiter auto\./);
  const auto = run([...base, '--delimiter', 'auto'], dir);
  assert.equal(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /^Separators: before semicolon, after tab \(detected\)\.$/m);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.equal(report.totals.delta, '0.20');
  await writeFile(join(dir, 'after.csv'), 'account;amount\nalpha;1.30\nbeta;2\n');
  const semicolon = run([...base, '--delimiter', 'semicolon'], dir);
  assert.equal(semicolon.status, 0, semicolon.stderr);
  assert.doesNotMatch(semicolon.stdout, /Separators/, 'Only detected separators are reported.');
  await writeFile(join(dir, 'after.csv'), 'account;amount\nalpha;1,30\n');
  const parse = run(base, dir);
  assert.equal(parse.status, 1);
  assert.match(parse.stderr, /After CSV after\.csv \(read as comma-separated\): CSV record 2 has 2 fields; expected 1\. Check --delimiter\./);
});

test('comparisons can write only data outputs, and HTML reports record when they were made', async t => {
  const dir = await fixture(t);
  const markdownOnly = run(['before.csv', 'after.csv', '--key', 'account', '--value', 'amount', '--markdown', 'summary.md'], dir);
  assert.equal(markdownOnly.status, 0, markdownOnly.stderr);
  assert.match(await readFile(join(dir, 'summary.md'), 'utf8'), /# Rowglass comparison/);
  assert.equal(existsSync(join(dir, 'report.html')), false);
  const started = Date.now();
  assert.equal(run(compare, dir).status, 0);
  const html = await readFile(join(dir, 'report.html'), 'utf8');
  const state = JSON.parse(html.match(/<script id="rowglass-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.ok(Date.parse(state.generatedAt) >= started - 1000);
  assert.equal(run(['demo', '--out', 'demo.html'], dir).status, 0);
  const demo = await readFile(join(dir, 'demo.html'), 'utf8');
  assert.match(demo, /"generatedAt":null/);
});
