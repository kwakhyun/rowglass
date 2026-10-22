#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCSV, reconcile } from '../src/engine.mjs';
import { renderApp } from '../src/render.mjs';

const VERSION = '0.1.0';
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const HELP = `Rowglass ${VERSION} — explain the difference between two CSV totals.

Usage:
  rowglass before.csv after.csv --key account --value amount --out report.html
  rowglass demo --out report.html
  rowglass app --out rowglass.html

Options:
  --key COLUMN         Row identity column; repeat for a composite key.
  --value COLUMN       Numeric column to reconcile.
  --out PATH           Write a standalone HTML report (required).
  --json PATH          Also write the reconciliation as JSON.
  --delimiter FORMAT   comma (default) or tab.
  --fail-on-change     Exit 2 if rows were added, removed, or changed.
  --force              Replace existing output files.
  --help, -h           Show this help.
  --version, -v        Show the version.

app creates a standalone browser app. demo uses the bundled example CSVs.
Files stay local. Outputs never replace input files, even with --force.
Exit codes: 0 success, 1 invalid input or failure, 2 changes with --fail-on-change.
`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) return { command: 'version' };
  if (!args.length) fail('No command or CSV files supplied. Run rowglass --help for usage.');

  const options = { command: 'compare', keys: [], delimiter: ',', force: false, failOnChange: false };
  const values = new Map([
    ['--key', 'keys'], ['--value', 'value'], ['--out', 'out'], ['--json', 'json'], ['--delimiter', 'delimiter'],
  ]);
  const switches = new Map([['--force', 'force'], ['--fail-on-change', 'failOnChange']]);
  const seen = new Set();
  const positional = [];
  const remaining = [...args];
  if (['app', 'demo'].includes(remaining[0])) options.command = remaining.shift();
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];
    if (values.has(arg) || switches.has(arg)) {
      if (seen.has(arg) && arg !== '--key') fail(`Option ${arg} was supplied more than once.`);
      seen.add(arg);
      if (switches.has(arg)) {
        options[switches.get(arg)] = true;
        continue;
      }
      const value = remaining[++i];
      if (value === undefined || value === '' || value.startsWith('--')) fail(`Option ${arg} needs a value.`);
      if (arg === '--key') options.keys.push(value);
      else if (arg === '--delimiter') {
        if (!['comma', 'tab'].includes(value)) fail('--delimiter must be comma or tab.');
        options.delimiter = value === 'tab' ? '\t' : ',';
      } else options[values.get(arg)] = value;
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}. Run rowglass --help for usage.`);
    } else {
      positional.push(arg);
    }
  }
  if (!options.out) fail('--out is required.');
  if (options.command === 'compare') {
    if (positional.length !== 2) fail('Supply exactly two input CSV paths.');
    if (!options.keys.length) fail('At least one --key column is required.');
    if (!options.value) fail('--value is required.');
    if (new Set(options.keys).size !== options.keys.length) fail('Each --key column must be unique.');
    options.inputs = positional;
  } else {
    if (positional.length) fail(`${options.command} does not accept input CSV paths.`);
    for (const flag of ['--key', '--value', '--delimiter']) {
      if (seen.has(flag)) fail(`${flag} is not supported with ${options.command}.`);
    }
    if (options.command === 'app') {
      for (const flag of ['--json', '--fail-on-change']) {
        if (seen.has(flag)) fail(`${flag} is not supported with app.`);
      }
    } else {
      const examples = fileURLToPath(new URL('../examples/', import.meta.url));
      options.inputs = [join(examples, 'before.csv'), join(examples, 'after.csv')];
      options.keys = ['account'];
      options.value = 'amount';
    }
  }
  return options;
}

async function statIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

async function readInput(path) {
  const absolute = resolve(path);
  const handle = await open(absolute, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail(`Input is not a regular file: ${path}`);
    if (stat.size > MAX_INPUT_BYTES) fail(`Input exceeds the 20 MiB limit: ${path}`);
    // Bound the read too, in case another process grows the file after stat().
    const chunks = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_INPUT_BYTES) fail(`Input exceeds the 20 MiB limit: ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    } catch {
      fail(`Input must be valid UTF-8: ${path}`);
    }
    return { text, path: absolute, canonical: await realpath(absolute), stat };
  } finally {
    await handle.close();
  }
}

function sameFile(first, second) {
  return first && second && first.dev === second.dev && first.ino === second.ino;
}

async function checkOutput(path, inputs, force) {
  const absolute = resolve(path);
  const stat = await statIfExists(absolute);
  if (stat?.isSymbolicLink()) fail(`Refusing a symbolic link output: ${path}`);
  if (stat && !stat.isFile()) fail(`Output is not a regular file: ${path}`);
  const canonical = await canonicalPath(absolute);
  if (inputs.some(input => input.canonical === canonical || sameFile(input.stat, stat))) {
    fail(`Output must not replace an input file: ${path}`);
  }
  if (stat && !force) fail(`Output already exists: ${path}. Use --force to replace it.`);
  return { path: absolute, canonical, stat };
}

async function writeOutputs(outputs, inputs, force) {
  const pending = [];
  try {
    // Prepare every file before exposing any new output path.
    for (const output of outputs) {
      await mkdir(dirname(output.path), { recursive: true });
      const tempPath = join(dirname(output.path), `.rowglass-${randomUUID()}.tmp`);
      const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
      pending.push({ ...output, tempPath });
      try {
        await handle.writeFile(output.content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const output of pending) {
      // Recheck just before commit. rename never follows a destination symlink;
      // link gives exclusive creation without a check-then-write overwrite race.
      await checkOutput(output.path, inputs, force);
      if (force) await rename(output.tempPath, output.path);
      else await link(output.tempPath, output.path);
    }
  } finally {
    await Promise.all(pending.map(output => unlink(output.tempPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    })));
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') return process.stdout.write(HELP);
  if (options.command === 'version') return process.stdout.write(`${VERSION}\n`);

  const inputs = options.inputs ? await Promise.all(options.inputs.map(readInput)) : [];
  const output = await checkOutput(options.out, inputs, options.force);
  const jsonOutput = options.json ? await checkOutput(options.json, inputs, options.force) : null;
  if (jsonOutput && output.canonical === jsonOutput.canonical) fail('--out and --json must use different paths.');

  const report = inputs.length ? reconcile(
    parseCSV(inputs[0].text, { delimiter: options.delimiter }),
    parseCSV(inputs[1].text, { delimiter: options.delimiter }),
    {
      keys: options.keys,
      value: options.value,
      beforeName: basename(inputs[0].path),
      afterName: basename(inputs[1].path),
    },
  ) : null;
  const outputs = [{ ...output, content: await renderApp(report, { sample: options.command === 'demo' }) }];
  if (jsonOutput) outputs.push({ ...jsonOutput, content: `${JSON.stringify(report, null, 2)}\n` });
  await writeOutputs(outputs, inputs, options.force);

  process.stdout.write(`HTML: ${output.path}\n`);
  if (jsonOutput) process.stdout.write(`JSON: ${jsonOutput.path}\n`);
  if (report) {
    const { added, removed, changed, unchanged } = report.counts;
    process.stdout.write(`Rows: ${added} added, ${removed} removed, ${changed} changed, ${unchanged} unchanged.\n`);
    if (options.failOnChange && added + removed + changed > 0) process.exitCode = 2;
  } else {
    process.stdout.write('Open the HTML file in a browser to compare CSV files locally.\n');
  }
}

main().catch(error => {
  process.stderr.write(`rowglass: ${error.message}\n`);
  process.exitCode = 1;
});
