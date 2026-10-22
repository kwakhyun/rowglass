import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    [...compare, '--delimiter', 'semicolon'],
    [...compare, '--out', 'second.html'],
    [...compare, '--key', 'account'],
    [...compare, '--force', '--force'],
    ['before.csv', 'after.csv', '--value', 'amount', '--out', 'report.html'],
    ['before.csv', 'after.csv', '--key', 'account', '--out', 'report.html'],
    ['before.csv', '--key', 'account', '--value', 'amount', '--out', 'report.html'],
    ['app', '--out', 'report.html', '--json', 'report.json'],
    ['app', '--out', 'report.html', '--fail-on-change'],
    ['demo', '--out', 'report.html', '--key', 'account'],
    ['app', '--out', 'report.html', 'unexpected.csv'],
    [],
  ];
  for (const args of cases) {
    const result = run(args, dir);
    assert.equal(result.status, 1, `Expected invalid arguments: ${JSON.stringify(args)}\n${result.stderr}`);
    assert.equal(existsSync(join(dir, 'report.html')), false);
    assert.equal(existsSync(join(dir, 'report.json')), false);
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
