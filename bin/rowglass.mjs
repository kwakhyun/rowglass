#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXT_ENCODINGS, decodeText, detectDelimiter, parseCSV, reconcile } from '../src/engine.mjs';
import { renderApp } from '../src/render.mjs';
import { renderChangesCSV, renderMarkdown } from '../src/exports.mjs';

const VERSION = '0.1.0';
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const HELP = `Rowglass ${VERSION} — explain the difference between two CSV totals.

Usage:
  rowglass before.csv after.csv --key account --value amount --out report.html
  rowglass before.csv after.csv --key account --value amount --markdown summary.md
  rowglass demo --out report.html
  rowglass app --out rowglass.html

Options:
  --key COLUMN         Row identity column; repeat for a composite key.
  --group-by COLUMN    Sum rows by this column; repeat for several columns.
                       Use instead of --key for nonunique source keys.
  --value COLUMN       Numeric column to reconcile.
  --out PATH           Write a standalone HTML report.
  --json PATH          Write the reconciliation as JSON.
  --csv PATH           Write every changed row or group as CSV.
  --markdown PATH      Write a Markdown summary.
                       Comparisons need at least one of these outputs;
                       app and demo need --out.
  --delimiter FORMAT   comma (default), tab, semicolon, or auto. auto
                       detects each file from its first records and
                       prints the separator it used.
  --encoding NAME      utf-8 (default) or euc-kr for both files, or
                       BEFORE,AFTER such as euc-kr,utf-8. Use euc-kr for
                       CSV files saved by Korean editions of Excel (CP949).
  --fail-on-change     Exit 2 for added, removed, or changed rows/groups.
  --force              Replace existing output files.
  --help, -h           Show this help.
  --version, -v        Show the version.

app creates a standalone browser app. demo uses the bundled example CSVs.
--key and --group-by are mutually exclusive. Group mode compares sums;
source row count changes alone do not trigger --fail-on-change.
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

  const options = { command: 'compare', keys: [], groupBy: [], delimiter: ',', encodings: ['utf-8', 'utf-8'], force: false, failOnChange: false };
  const values = new Map([
    ['--key', 'keys'], ['--group-by', 'groupBy'], ['--value', 'value'], ['--out', 'out'],
    ['--json', 'json'], ['--csv', 'csv'], ['--markdown', 'markdown'], ['--delimiter', 'delimiter'], ['--encoding', 'encoding'],
  ]);
  const delimiters = new Map([['comma', ','], ['tab', '\t'], ['semicolon', ';'], ['auto', 'auto']]);
  const switches = new Map([['--force', 'force'], ['--fail-on-change', 'failOnChange']]);
  const seen = new Set();
  const positional = [];
  const remaining = [...args];
  if (['app', 'demo'].includes(remaining[0])) options.command = remaining.shift();
  for (let i = 0; i < remaining.length; i += 1) {
    const arg = remaining[i];
    if (values.has(arg) || switches.has(arg)) {
      if (seen.has(arg) && !['--key', '--group-by'].includes(arg)) fail(`Option ${arg} was supplied more than once.`);
      seen.add(arg);
      if (switches.has(arg)) {
        options[switches.get(arg)] = true;
        continue;
      }
      const value = remaining[++i];
      if (value === undefined || value === '' || value.startsWith('--')) fail(`Option ${arg} needs a value.`);
      if (arg === '--key') options.keys.push(value);
      else if (arg === '--group-by') options.groupBy.push(value);
      else if (arg === '--delimiter') {
        if (!delimiters.has(value)) fail('--delimiter must be comma, tab, semicolon, or auto.');
        options.delimiter = delimiters.get(value);
      } else if (arg === '--encoding') {
        const names = value.toLowerCase().split(',');
        if (names.length > 2 || !names.every(name => TEXT_ENCODINGS.includes(name))) {
          fail('--encoding must be utf-8 or euc-kr, or a BEFORE,AFTER pair such as euc-kr,utf-8.');
        }
        options.encodings = names.length === 1 ? [names[0], names[0]] : names;
      } else options[values.get(arg)] = value;
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}. Run rowglass --help for usage.`);
    } else {
      positional.push(arg);
    }
  }
  if (options.command !== 'compare' && !options.out) fail('--out is required.');
  if (options.command === 'compare') {
    if (!['out', 'json', 'csv', 'markdown'].some(option => options[option])) {
      fail('Choose at least one output: --out, --json, --csv, or --markdown.');
    }
    if (positional.length !== 2) fail('Supply exactly two input CSV paths.');
    if (!options.keys.length && !options.groupBy.length) fail('At least one --key or --group-by column is required.');
    if (options.keys.length && options.groupBy.length) fail('--key and --group-by cannot be used together.');
    if (!options.value) fail('--value is required.');
    if (new Set(options.keys).size !== options.keys.length) fail('Each --key column must be unique.');
    if (new Set(options.groupBy).size !== options.groupBy.length) fail('Each --group-by column must be unique.');
    options.inputs = positional;
  } else {
    if (positional.length) fail(`${options.command} does not accept input CSV paths.`);
    for (const flag of ['--key', '--group-by', '--value', '--delimiter', '--encoding']) {
      if (seen.has(flag)) fail(`${flag} is not supported with ${options.command}.`);
    }
    if (options.command === 'app') {
      for (const flag of ['--json', '--csv', '--markdown', '--fail-on-change']) {
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

const SIDES = ['Before', 'After'];
const DELIMITER_NAMES = new Map([[',', 'comma'], ['\t', 'tab'], [';', 'semicolon']]);

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
    return { bytes: Buffer.concat(chunks, bytes), path: absolute, given: path, canonical: await realpath(absolute), stat };
  } finally {
    await handle.close();
  }
}

// Decode every input before reporting, so the advice covers both files at once.
function decodeInputs(inputs, encodings) {
  const problems = [];
  const advised = [...encodings];
  inputs.forEach((input, index) => {
    try {
      input.text = decodeText(input.bytes, encodings[index]);
    } catch (error) {
      advised[index] = encodings[index] === 'utf-8' ? 'euc-kr' : 'utf-8';
      const problem = encodings[index] === 'utf-8' ? 'must be valid UTF-8'
        : /byte order mark/.test(error.message) ? 'starts with a UTF-8 byte order mark, so it is UTF-8, not EUC-KR'
          : 'must be valid EUC-KR (CP949)';
      problems.push(`${SIDES[index]} input ${problem}: ${input.given}.`);
    }
    input.bytes = null;
  });
  if (!problems.length) return;
  const korean = advised.includes('euc-kr') ? ' CSV files saved by Korean editions of Excel are EUC-KR (CP949).' : '';
  fail(`${problems.join(' ')}${korean} Try --encoding ${advised[0] === advised[1] ? advised[0] : advised.join(',')}.`);
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
  decodeInputs(inputs, options.encodings);
  const outputs = [];
  for (const [option, label] of [['out', 'HTML'], ['json', 'JSON'], ['csv', 'CSV'], ['markdown', 'Markdown']]) {
    if (!options[option]) continue;
    const output = { ...await checkOutput(options[option], inputs, options.force), option, label };
    const duplicate = outputs.find(existing => existing.canonical === output.canonical || sameFile(existing.stat, output.stat));
    if (duplicate) fail(`--${duplicate.option} and --${option} must use different output files.`);
    outputs.push(output);
  }

  const datasets = inputs.map((input, index) => {
    input.delimiter = options.delimiter === 'auto' ? detectDelimiter(input.text) : options.delimiter;
    try {
      return parseCSV(input.text, { delimiter: input.delimiter });
    } catch (error) {
      const hint = /fields; expected/.test(error.message) ? ' Check --delimiter.' : '';
      fail(`${SIDES[index]} CSV ${basename(input.path)} (read as ${DELIMITER_NAMES.get(input.delimiter)}-separated): ${error.message}${hint}`);
    }
  });
  let report = null;
  if (inputs.length) {
    try {
      report = reconcile(datasets[0], datasets[1], {
        keys: options.groupBy.length ? options.groupBy : options.keys,
        aggregate: options.groupBy.length > 0,
        value: options.value,
        beforeName: basename(inputs[0].path),
        afterName: basename(inputs[1].path),
      });
    } catch (error) {
      // A single parsed column usually means the file uses another separator.
      const mismatch = inputs.findIndex((input, index) => datasets[index].headers.length === 1 && detectDelimiter(input.text) !== input.delimiter);
      if (mismatch < 0 || !/missing column/.test(error.message)) throw error;
      const detected = DELIMITER_NAMES.get(detectDelimiter(inputs[mismatch].text));
      fail(`${error.message} ${SIDES[mismatch]} CSV ${basename(inputs[mismatch].path)} has one column when read as ${DELIMITER_NAMES.get(inputs[mismatch].delimiter)}-separated, but its header looks ${detected}-separated. Add --delimiter ${detected} or --delimiter auto.`);
    }
  }
  for (const output of outputs) {
    if (output.option === 'out') {
      output.content = await renderApp(report, {
        sample: options.command === 'demo',
        generatedAt: options.command === 'compare' ? new Date().toISOString() : null,
      });
    }
    else if (output.option === 'json') output.content = `${JSON.stringify(report, null, 2)}\n`;
    else if (output.option === 'csv') output.content = renderChangesCSV(report);
    else if (output.option === 'markdown') output.content = renderMarkdown(report);
  }
  await writeOutputs(outputs, inputs, options.force);

  for (const output of outputs) process.stdout.write(`${output.label}: ${output.path}\n`);
  if (report && options.delimiter === 'auto') {
    process.stdout.write(`Separators: ${inputs.map((input, index) => `${SIDES[index].toLowerCase()} ${DELIMITER_NAMES.get(input.delimiter)}`).join(', ')} (detected).\n`);
  }
  if (report) {
    const { added, removed, changed, unchanged } = report.counts;
    process.stdout.write(`${report.aggregation === 'sum' ? 'Groups' : 'Rows'}: ${added} added, ${removed} removed, ${changed} changed, ${unchanged} unchanged.\n`);
    if (report.aggregation === 'sum') process.stdout.write(`Source rows: ${report.sourceCounts.before} before, ${report.sourceCounts.after} after.\n`);
    if (options.failOnChange && added + removed + changed > 0) process.exitCode = 2;
  } else {
    process.stdout.write('Open the HTML file in a browser to compare CSV files locally.\n');
  }
}

main().catch(error => {
  process.stderr.write(`rowglass: ${error.message}\n`);
  process.exitCode = 1;
});
